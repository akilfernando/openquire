//! The OpenQuire desktop shell: the web app in a native window, with native file access.
//!
//! The PDF engine runs in the web view exactly as in the browser. This side only reads and
//! writes the files the user opens (so documents save in place), and hands over PDFs opened from
//! the operating system: on the command line, through file associations, or in a second launch.

mod pkcs11;

use std::path::Path;
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager};

/// Files waiting for the web app to collect them, in case they arrive before it is listening.
struct Pending(Mutex<Vec<String>>);

fn pdf_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-') && Path::new(a).is_file())
        .collect()
}

fn hand_over(app: &tauri::AppHandle, files: Vec<String>) {
    if files.is_empty() {
        return;
    }
    app.state::<Pending>().0.lock().unwrap().extend(files.iter().cloned());
    let _ = app.emit("open-files", files);
}

/// Reads a file as raw bytes.
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

/// Writes raw bytes to the path in the percent-encoded "path" header, via a temporary file so a
/// failed write never leaves a half-written document.
#[tauri::command]
fn write_file(request: Request) -> Result<(), String> {
    let encoded = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .ok_or("No file path was given")?;
    let path = percent_decode_str(encoded).decode_utf8().map_err(|e| e.to_string())?.to_string();
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the file's bytes".into());
    };
    let tmp = format!("{path}.openquire-saving");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Files opened from the operating system that the web app hasn't collected yet.
#[tauri::command]
fn take_opened_files(state: tauri::State<Pending>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// Certificates on the smart cards the PKCS#11 library can see.
#[tauri::command]
async fn token_certificates(module: String) -> Result<Vec<pkcs11::TokenCert>, String> {
    tauri::async_runtime::spawn_blocking(move || pkcs11::list(&module)).await.map_err(|e| e.to_string())?
}

/// Signs a DigestInfo with a key on a smart card.
#[tauri::command]
async fn token_sign(module: String, slot: u64, id: String, pin: String, digest_info: Vec<u8>) -> Result<Response, String> {
    let sig = tauri::async_runtime::spawn_blocking(move || pkcs11::sign(&module, slot, &id, &pin, &digest_info))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Response::new(sig))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial = pdf_args(std::env::args().skip(1));
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // A second launch (double-clicking another PDF) opens it in the running window.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            hand_over(app, pdf_args(argv.into_iter().skip(1)));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(Pending(Mutex::new(initial)))
        .invoke_handler(tauri::generate_handler![read_file, write_file, take_opened_files, token_certificates, token_sign])
        .build(tauri::generate_context!())
        .expect("error while starting OpenQuire")
        .run(|_app, _event| {
            // macOS delivers files opened from Finder as an event rather than arguments.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                let files = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                hand_over(_app, files);
            }
        });
}
