//! Installed LibreOffice and Tesseract, when present: higher-fidelity Office conversion and
//! faster OCR than the built-in engines. Each run works on files in a fresh temporary folder,
//! which is removed afterwards.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

#[derive(Serialize, Default)]
pub struct Tools {
    pub libreoffice: Option<String>,
    pub tesseract: Option<String>,
    /// Languages Tesseract has data for, e.g. ["eng", "fra"].
    pub tesseract_langs: Vec<String>,
}

fn on_path(name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join(&exe)).find(|f| f.is_file()))
}

fn first_existing(candidates: &[&str]) -> Option<PathBuf> {
    candidates.iter().map(PathBuf::from).find(|p| p.is_file())
}

fn find_libreoffice() -> Option<PathBuf> {
    on_path("soffice").or_else(|| on_path("libreoffice")).or_else(|| {
        first_existing(&[
            r"C:\Program Files\LibreOffice\program\soffice.exe",
            r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
            "/Applications/LibreOffice.app/Contents/MacOS/soffice",
            "/usr/bin/soffice",
            "/usr/lib/libreoffice/program/soffice",
            "/snap/bin/libreoffice",
        ])
    })
}

fn find_tesseract() -> Option<PathBuf> {
    on_path("tesseract").or_else(|| {
        first_existing(&[
            r"C:\Program Files\Tesseract-OCR\tesseract.exe",
            r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
            "/opt/homebrew/bin/tesseract",
            "/usr/local/bin/tesseract",
            "/usr/bin/tesseract",
        ])
    })
}

fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: no console flashes up while converting.
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

pub fn detect() -> Tools {
    let tesseract = find_tesseract();
    let tesseract_langs = tesseract
        .as_ref()
        .and_then(|t| quiet(Command::new(t).arg("--list-langs")).output().ok())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .skip(1)
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty() && l != "osd")
                .collect()
        })
        .unwrap_or_default();
    Tools {
        libreoffice: find_libreoffice().map(|p| p.to_string_lossy().into_owned()),
        tesseract: tesseract.map(|p| p.to_string_lossy().into_owned()),
        tesseract_langs,
    }
}

/// A temporary folder removed when dropped.
struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Result<Self, String> {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("openquire-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(Self(dir))
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn safe_ext(ext: &str) -> Result<&str, String> {
    if !ext.is_empty() && ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        Ok(ext)
    } else {
        Err("Unsupported file type".into())
    }
}

/// Converts an Office (or other LibreOffice-readable) document to PDF.
pub fn convert_to_pdf(bytes: &[u8], ext: &str) -> Result<Vec<u8>, String> {
    let soffice = find_libreoffice().ok_or("LibreOffice is not installed.")?;
    let tmp = TempDir::new()?;
    let input = tmp.0.join(format!("document.{}", safe_ext(ext)?));
    std::fs::write(&input, bytes).map_err(|e| e.to_string())?;
    // A private profile, so a running LibreOffice doesn't block the conversion.
    let profile = format!("-env:UserInstallation=file:///{}", tmp.0.join("profile").to_string_lossy().replace('\\', "/").trim_start_matches('/'));
    let out = quiet(Command::new(&soffice).args([&profile, "--headless", "--norestore", "--convert-to", "pdf", "--outdir"]).arg(&tmp.0).arg(&input))
        .output()
        .map_err(|e| format!("Couldn't run LibreOffice: {e}"))?;
    let pdf = tmp.0.join("document.pdf");
    if !pdf.is_file() {
        return Err(format!("LibreOffice couldn't convert the file. {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    std::fs::read(pdf).map_err(|e| e.to_string())
}

/// Recognizes text in a PNG and returns Tesseract's TSV (word boxes with confidences).
pub fn ocr_tsv(png: &[u8], lang: &str) -> Result<String, String> {
    let tesseract = find_tesseract().ok_or("Tesseract is not installed.")?;
    if !lang.split('+').all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')) {
        return Err("Unknown language".into());
    }
    let tmp = TempDir::new()?;
    let input = tmp.0.join("page.png");
    std::fs::write(&input, png).map_err(|e| e.to_string())?;
    let out = quiet(Command::new(&tesseract).arg(&input).arg("stdout").args(["-l", lang, "--psm", "3", "tsv"]))
        .output()
        .map_err(|e| format!("Couldn't run Tesseract: {e}"))?;
    if !out.status.success() {
        return Err(format!("Tesseract failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    //! Run in CI with LibreOffice and Tesseract installed (OPENQUIRE_TEST_TOOLS=1).
    use super::*;

    #[test]
    fn converts_and_recognizes_with_installed_tools() {
        if std::env::var("OPENQUIRE_TEST_TOOLS").is_err() {
            return;
        }
        let tools = detect();
        assert!(tools.libreoffice.is_some() && tools.tesseract.is_some());
        assert!(tools.tesseract_langs.iter().any(|l| l == "eng"));

        let pdf = convert_to_pdf(b"Hello from LibreOffice\n", "txt").expect("convert");
        assert!(pdf.starts_with(b"%PDF"));

        let png = std::fs::read(std::env::var("OPENQUIRE_TEST_PNG").expect("test image")).unwrap();
        let tsv = ocr_tsv(&png, "eng").expect("ocr");
        assert!(tsv.starts_with("level\tpage_num"));
        assert!(tsv.contains("agree"));
        assert!(ocr_tsv(&png, "eng; rm").is_err());
        assert!(convert_to_pdf(b"x", "../x").is_err());
    }
}
