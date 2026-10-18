//! System-browser navigation for the fixed setup resources shown in Settings.

use tauri_plugin_opener::OpenerExt;

const SETUP_URLS: &[&str] = &[
    "https://platform.openai.com/api-keys",
    "https://platform.claude.com/docs/en/get-api-key",
    "https://ai.google.dev/gemini-api/docs/api-key",
    "https://docs.x.ai/developers/quickstart",
    "https://ollama.com/download",
    "https://nodejs.org/en/download",
    "https://learn.chatgpt.com/docs/extend/mcp",
];

fn validate_setup_url(url: &str) -> Result<(), String> {
    if SETUP_URLS.contains(&url) {
        Ok(())
    } else {
        Err("This URL is not an approved OpenQuire setup resource.".into())
    }
}

/// Rust opener methods bypass plugin scopes, so enforce an exact allowlist first.
#[tauri::command]
pub async fn open_setup_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
    validate_setup_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|error| format!("Could not open the setup page in your browser: {error}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{validate_setup_url, SETUP_URLS};

    #[test]
    fn accepts_each_exact_setup_resource() {
        assert_eq!(SETUP_URLS.len(), 7);
        for url in SETUP_URLS {
            assert!(validate_setup_url(url).is_ok(), "{url}");
        }
    }

    #[test]
    fn rejects_variations_and_non_setup_targets() {
        for url in SETUP_URLS {
            for changed in [
                format!("{url}?redirect=https://example.com"),
                format!("{url}#fragment"),
                format!("{url}/"),
                format!(" {url}"),
                format!("{url}\n"),
                url.replacen("https://", "http://", 1),
                url.replacen("https://", "https://user:password@", 1),
                url.replacen("https://", "https://attacker.example/", 1),
            ] {
                assert!(validate_setup_url(&changed).is_err(), "{changed}");
            }
        }
        for url in [
            "https://example.com",
            "https://platform.openai.com/",
            "https://platform.openai.com.evil.example/api-keys",
            "https://platform.openai.com:443/api-keys",
            "file:///C:/Windows/System32/cmd.exe",
            "C:\\Windows\\System32\\cmd.exe",
            "javascript:alert(1)",
            "shell:AppsFolder",
            "cmd /c start https://platform.openai.com/api-keys",
            "https://platform.openai.com/api-keys; calc.exe",
            "",
        ] {
            assert!(validate_setup_url(url).is_err(), "{url}");
        }
    }
}
