use std::fs;
#[allow(unused_imports)]
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AssistantStatus {
    pub name: String,
    pub installed: bool,
    pub linked: bool,
    pub config_path: Option<String>,
    pub details: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AiAssistantsReport {
    pub claude_desktop: AssistantStatus,
    pub chatgpt_desktop: AssistantStatus,
    pub cursor: AssistantStatus,
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// Returns all possible platform paths for Claude Desktop config
pub fn claude_config_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let store = PathBuf::from(local)
                .join("Packages")
                .join("Claude_pzs8sxrjxfjjc")
                .join("LocalCache")
                .join("Roaming")
                .join("Claude")
                .join("claude_desktop_config.json");
            paths.push(store);
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            paths.push(PathBuf::from(appdata).join("Claude").join("claude_desktop_config.json"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = home_dir() {
            paths.push(home.join("Library").join("Application Support").join("Claude").join("claude_desktop_config.json"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(config_home) = std::env::var_os("XDG_CONFIG_HOME") {
            paths.push(PathBuf::from(config_home).join("Claude").join("claude_desktop_config.json"));
        } else if let Some(home) = home_dir() {
            paths.push(home.join(".config").join("Claude").join("claude_desktop_config.json"));
        }
    }
    paths
}

/// Checks if Claude Desktop is installed (via app bundle, executable, or existing config)
fn is_claude_installed() -> (bool, Option<PathBuf>, bool) {
    let configs = claude_config_paths();
    for p in &configs {
        if p.exists() {
            let is_linked = fs::read_to_string(p)
                .ok()
                .and_then(|c| serde_json::from_str::<Value>(&c).ok())
                .and_then(|v| v.get("mcpServers")?.get("openquire").cloned())
                .is_some();
            return (true, Some(p.clone()), is_linked);
        }
    }

    // Also check application directories if config hasn't been created yet
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let exe = PathBuf::from(&local).join("Programs").join("Claude").join("Claude.exe");
            if exe.exists() {
                return (true, configs.first().cloned(), false);
            }
            // Check Store package folder
            let store_dir = PathBuf::from(local).join("Packages").join("Claude_pzs8sxrjxfjjc");
            if store_dir.exists() {
                return (true, configs.first().cloned(), false);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if Path::new("/Applications/Claude.app").exists() {
            return (true, configs.first().cloned(), false);
        }
    }

    (false, configs.first().cloned(), false)
}

/// Checks if ChatGPT Desktop is installed
fn is_chatgpt_installed() -> bool {
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let exe = PathBuf::from(&local).join("Programs").join("ChatGPT").join("ChatGPT.exe");
            if exe.exists() {
                return true;
            }
            // Check Windows packages
            let pkgs = PathBuf::from(&local).join("Packages");
            if let Ok(entries) = fs::read_dir(pkgs) {
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy().contains("OpenAI.ChatGPT") {
                        return true;
                    }
                }
            }
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            if PathBuf::from(appdata).join("OpenAI").join("ChatGPT").exists() {
                return true;
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if Path::new("/Applications/ChatGPT.app").exists() {
            return true;
        }
    }
    false
}

/// Checks if Cursor is installed and configured
fn is_cursor_installed() -> (bool, bool) {
    let mut installed = false;
    let mut linked = false;

    if let Some(home) = home_dir() {
        let cursor_dir = home.join(".cursor");
        if cursor_dir.exists() {
            installed = true;
            let mcp_file = cursor_dir.join("mcp.json");
            if mcp_file.exists() {
                linked = fs::read_to_string(&mcp_file)
                    .ok()
                    .and_then(|c| serde_json::from_str::<Value>(&c).ok())
                    .and_then(|v| v.get("mcpServers")?.get("openquire").cloned())
                    .is_some();
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if Path::new("/Applications/Cursor.app").exists() {
            installed = true;
        }
    }

    (installed, linked)
}

/// Scans the machine for AI desktop assistants and their MCP status
pub fn detect_all() -> AiAssistantsReport {
    let (claude_inst, claude_cfg, claude_linked) = is_claude_installed();
    let chatgpt_inst = is_chatgpt_installed();
    let (cursor_inst, cursor_linked) = is_cursor_installed();

    AiAssistantsReport {
        claude_desktop: AssistantStatus {
            name: "Claude Desktop".into(),
            installed: claude_inst,
            linked: claude_linked,
            config_path: claude_cfg.map(|p| p.to_string_lossy().into_owned()),
            details: if claude_linked {
                Some("Configured with OpenQuire local MCP server".into())
            } else if claude_inst {
                Some("Installed on this machine. Ready to connect.".into())
            } else {
                None
            },
        },
        chatgpt_desktop: AssistantStatus {
            name: "ChatGPT Desktop".into(),
            installed: chatgpt_inst,
            linked: false,
            config_path: None,
            details: if chatgpt_inst {
                Some("Detected. Connector integration ready when open protocol expands.".into())
            } else {
                None
            },
        },
        cursor: AssistantStatus {
            name: "Cursor".into(),
            installed: cursor_inst,
            linked: cursor_linked,
            config_path: None,
            details: if cursor_inst {
                Some("Code editor with native MCP support detected.".into())
            } else {
                None
            },
        },
    }
}

/// Links Claude Desktop to OpenQuire by updating claude_desktop_config.json
pub fn link_claude(allowed_dir: Option<String>) -> Result<String, String> {
    let paths = claude_config_paths();
    let target = paths
        .iter()
        .find(|p| p.parent().map(|d| d.exists()).unwrap_or(false))
        .or_else(|| paths.first())
        .ok_or_else(|| "Could not determine Claude Desktop configuration directory".to_string())?;

    let parent = target.parent().ok_or("Invalid configuration path")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let mut config: Value = if target.exists() {
        let content = fs::read_to_string(target).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };

    let dir = allowed_dir.unwrap_or_else(|| {
        home_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".into())
    });

    let (cmd, args) = if cfg!(windows) {
        (
            "cmd.exe",
            vec![
                "/c".to_string(),
                "npx".to_string(),
                "-y".to_string(),
                "openquire".to_string(),
                "mcp".to_string(),
                "--allow-dir".to_string(),
                dir,
            ],
        )
    } else {
        (
            "npx",
            vec![
                "-y".to_string(),
                "openquire".to_string(),
                "mcp".to_string(),
                "--allow-dir".to_string(),
                dir,
            ],
        )
    };

    let mcp_servers = config
        .as_object_mut()
        .ok_or("Config is not a JSON object")?
        .entry("mcpServers")
        .or_insert_with(|| json!({}));

    if let Some(servers) = mcp_servers.as_object_mut() {
        servers.insert(
            "openquire".to_string(),
            json!({
                "command": cmd,
                "args": args,
            }),
        );
    }

    let formatted = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(target, formatted + "\n").map_err(|e| e.to_string())?;

    Ok(target.to_string_lossy().into_owned())
}

/// Unlinks OpenQuire from Claude Desktop
pub fn unlink_claude() -> Result<(), String> {
    for p in claude_config_paths() {
        if !p.exists() {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&p) {
            if let Ok(mut config) = serde_json::from_str::<Value>(&content) {
                if let Some(servers) = config.get_mut("mcpServers").and_then(|s| s.as_object_mut()) {
                    if servers.remove("openquire").is_some() {
                        if let Ok(formatted) = serde_json::to_string_pretty(&config) {
                            let _ = fs::write(&p, formatted + "\n");
                        }
                    }
                }
            }
        }
    }
    Ok(())
}
