use openquire_core::PdfDocument;
use openquire_crypto::{create_digital_id, CreateDigitalIdOptions};
use std::fs;
use std::process::Command;
use tempfile::tempdir;

fn binary_path() -> std::path::PathBuf {
    let mut path = std::env::current_exe().unwrap();
    path.pop(); // deps
    if path.ends_with("deps") {
        path.pop();
    }
    path.push("openquire");
    if !path.exists() {
        // Fallback to release or debug binary
        let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.pop();
        p.pop();
        p.push("target");
        p.push("release");
        p.push("openquire");
        if p.exists() {
            return p;
        }
        let mut d = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        d.pop();
        d.pop();
        d.push("target");
        d.push("debug");
        d.push("openquire");
        return d;
    }
    path
}

fn create_pdf(text: &str) -> Vec<u8> {
    use lopdf::content::{Content, Operation};
    use lopdf::{Dictionary, Document, Object, StringFormat};

    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();

    let mut font_dict = Dictionary::new();
    font_dict.set("Type", "Font");
    font_dict.set("Subtype", "Type1");
    font_dict.set("BaseFont", "Helvetica");
    let font_id = doc.add_object(Object::Dictionary(font_dict));

    let content_ops = vec![
        Operation::new("BT", vec![]),
        Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), Object::Real(12.0)]),
        Operation::new("Td", vec![Object::Real(50.0), Object::Real(700.0)]),
        Operation::new("Tj", vec![Object::String(text.as_bytes().to_vec(), StringFormat::Literal)]),
        Operation::new("ET", vec![]),
    ];
    let content = Content { operations: content_ops };
    let content_bytes = content.encode().unwrap();
    let stream_id = doc.add_object(Object::Stream(lopdf::Stream::new(Dictionary::new(), content_bytes)));

    let mut fonts = Dictionary::new();
    fonts.set("F1", Object::Reference(font_id));
    let mut resources = Dictionary::new();
    resources.set("Font", Object::Dictionary(fonts));

    let mut page_dict = Dictionary::new();
    page_dict.set("Type", "Page");
    page_dict.set("Parent", Object::Reference(pages_id));
    page_dict.set("MediaBox", vec![0.into(), 0.into(), 595.into(), 842.into()]);
    page_dict.set("Contents", Object::Reference(stream_id));
    page_dict.set("Resources", Object::Dictionary(resources));
    let page_id = doc.add_object(Object::Dictionary(page_dict));

    let mut pages_dict = Dictionary::new();
    pages_dict.set("Type", "Pages");
    pages_dict.set("Kids", vec![Object::Reference(page_id)]);
    pages_dict.set("Count", 1);
    doc.objects.insert(pages_id, Object::Dictionary(pages_dict));

    let mut catalog = Dictionary::new();
    catalog.set("Type", "Catalog");
    catalog.set("Pages", Object::Reference(pages_id));
    let catalog_id = doc.add_object(Object::Dictionary(catalog));
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

#[test]
fn test_cli_help_and_errors() {
    let bin = binary_path();

    let help = Command::new(&bin).arg("--help").output().unwrap();
    assert_eq!(help.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&help.stdout);
    assert!(stdout.contains("openquire <command>"));

    let unknown = Command::new(&bin).args(["frobnicate", "x.pdf"]).output().unwrap();
    assert_eq!(unknown.status.code(), Some(2));

    let missing = Command::new(&bin).args(["redact", "--pattern", "email", "missing_folder_test"]).output().unwrap();
    assert_eq!(missing.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&missing.stderr).contains("No such file or folder"));
}

#[test]
fn test_cli_redact_folder() {
    let bin = binary_path();
    let dir = tempdir().unwrap();

    let a_pdf = dir.path().join("a.pdf");
    let b_pdf = dir.path().join("b.pdf");
    fs::write(&a_pdf, create_pdf("Contact jane.doe@example.com today.")).unwrap();
    fs::write(&b_pdf, create_pdf("No personal information.")).unwrap();

    let out_dir = dir.path().join("out");
    let output = Command::new(&bin)
        .args(["redact", "--pattern", "email", dir.path().to_str().unwrap(), "-o", out_dir.to_str().unwrap()])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(0));
    assert!(out_dir.join("a.pdf").exists());
    assert!(out_dir.join("b.pdf").exists());

    let a_bytes = fs::read(out_dir.join("a.pdf")).unwrap();
    let doc = PdfDocument::open("a.pdf".to_string(), &a_bytes).unwrap();
    let text = doc.extract_text();
    assert!(!text.contains("jane.doe@example.com"));
    assert!(text.contains("Contact"));
}

#[test]
fn test_cli_bates_stamping() {
    let bin = binary_path();
    let dir = tempdir().unwrap();

    let doc_pdf = dir.path().join("doc.pdf");
    fs::write(&doc_pdf, create_pdf("First document page")).unwrap();

    let out_dir = dir.path().join("stamped_out");
    let output = Command::new(&bin)
        .args([
            "stamp",
            doc_pdf.to_str().unwrap(),
            "--text",
            "ACME-{bates}",
            "--position",
            "br",
            "--bates-start",
            "500",
            "-o",
            out_dir.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(0));
    let stamped_file = out_dir.join("doc.pdf");
    assert!(stamped_file.exists());

    let bytes = fs::read(stamped_file).unwrap();
    let doc = PdfDocument::open("doc.pdf".to_string(), &bytes).unwrap();
    assert!(doc.extract_text().contains("ACME-000500"));
}

#[test]
fn test_cli_merge() {
    let bin = binary_path();
    let dir = tempdir().unwrap();

    let f1 = dir.path().join("1.pdf");
    let f2 = dir.path().join("2.pdf");
    fs::write(&f1, create_pdf("File 1 content")).unwrap();
    fs::write(&f2, create_pdf("File 2 content")).unwrap();

    let merged_file = dir.path().join("merged.pdf");
    let output = Command::new(&bin)
        .args([
            "merge",
            f1.to_str().unwrap(),
            f2.to_str().unwrap(),
            "-o",
            merged_file.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(0));
    assert!(merged_file.exists());
    let bytes = fs::read(merged_file).unwrap();
    let doc = PdfDocument::open("merged.pdf".to_string(), &bytes).unwrap();
    assert_eq!(doc.page_count(), 2);
}

#[test]
fn test_cli_sign() {
    let bin = binary_path();
    let dir = tempdir().unwrap();

    let id_opts = CreateDigitalIdOptions {
        name: "Test Signer".to_string(),
        email: None,
        organization: None,
        password: "secret".to_string(),
        years: Some(1),
    };
    let p12_bytes = create_digital_id(&id_opts).unwrap();
    let p12_path = dir.path().join("id.p12");
    fs::write(&p12_path, p12_bytes).unwrap();

    let doc_path = dir.path().join("contract.pdf");
    fs::write(&doc_path, create_pdf("Contract to sign")).unwrap();

    let output = Command::new(&bin)
        .args([
            "sign",
            doc_path.to_str().unwrap(),
            "--p12",
            p12_path.to_str().unwrap(),
            "--password",
            "secret",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(0));
    let signed_file = dir.path().join("contract-signed.pdf");
    assert!(signed_file.exists());
}
