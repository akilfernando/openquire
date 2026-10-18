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
    #[serde(default)]
    pub codex_cli: AssistantStatus,
    #[serde(default)]
    pub claude_code: AssistantStatus,
}

fn command_file_names(command: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![
            format!("{command}.exe"),
            format!("{command}.cmd"),
            format!("{command}.bat"),
            command.to_string(),
        ]
    }
    #[cfg(not(windows))]
    {
        vec![command.to_string()]
    }
}

fn command_candidates(
    command: &str,
    path: Option<&std::ffi::OsStr>,
    home: Option<&Path>,
    npm_prefix: Option<&Path>,
    _appdata: Option<&Path>,
) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = path
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .collect();
    if let Some(home) = home {
        dirs.push(home.join(".local").join("bin"));
        #[cfg(not(windows))]
        {
            dirs.push(home.join(".npm-global").join("bin"));
            dirs.push(home.join(".npm").join("bin"));
        }
    }
    if let Some(prefix) = npm_prefix {
        dirs.push(prefix.join("bin"));
        #[cfg(windows)]
        dirs.push(prefix.to_path_buf());
    }
    #[cfg(windows)]
    if let Some(appdata) = _appdata {
        dirs.push(appdata.join("npm"));
    }

    dirs.into_iter()
        .flat_map(|dir| {
            command_file_names(command)
                .into_iter()
                .map(move |name| dir.join(name))
        })
        .collect()
}

fn find_command(command: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH");
    let home = home_dir();
    let prefix = std::env::var_os("NPM_CONFIG_PREFIX").map(PathBuf::from);
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    command_candidates(
        command,
        path.as_deref(),
        home.as_deref(),
        prefix.as_deref(),
        appdata.as_deref(),
    )
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn cli_status(name: &str, command: &str) -> AssistantStatus {
    let found = find_command(command);
    AssistantStatus {
        name: name.into(),
        installed: found.is_some(),
        linked: false,
        config_path: None,
        details: found.map(|p| format!("Command-line tool detected at {}.", p.display())),
    }
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
        codex_cli: cli_status("Codex CLI", "codex"),
        claude_code: cli_status("Claude Code", "claude"),
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

#[cfg(test)]
mod discovery_tests {
    use super::command_candidates;
    use std::ffi::OsStr;
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(std::path::PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "openquire-ai-detect-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn has_file(candidates: Vec<std::path::PathBuf>) -> bool {
        candidates.into_iter().any(|candidate| candidate.is_file())
    }

    #[test]
    fn cli_discovery_checks_path_and_user_install_locations_for_files_only() {
        let root = TestDir::new();
        let path_dir = root.0.join("path");
        let home = root.0.join("home");
        let prefix = root.0.join("npm-prefix");
        fs::create_dir_all(&path_dir).unwrap();
        fs::create_dir_all(home.join(".local").join("bin")).unwrap();
        fs::create_dir_all(prefix.join("bin")).unwrap();

        let path_candidates = command_candidates(
            "codex",
            Some(OsStr::new(path_dir.to_str().unwrap())),
            Some(&home),
            Some(Path::new("unused")),
            None,
        );
        let home_candidates = command_candidates("claude", None, Some(&home), None, None);
        let prefix_candidates = command_candidates("claude", None, None, Some(&prefix), None);
        assert!(!has_file(path_candidates.clone()));
        assert!(!has_file(home_candidates.clone()));
        assert!(!has_file(prefix_candidates.clone()));

        #[cfg(windows)]
        let codex = path_dir.join("codex.exe");
        #[cfg(not(windows))]
        let codex = path_dir.join("codex");
        fs::write(&codex, "fake executable marker").unwrap();
        assert!(has_file(path_candidates));

        #[cfg(windows)]
        let claude = home.join(".local").join("bin").join("claude.cmd");
        #[cfg(not(windows))]
        let claude = home.join(".local").join("bin").join("claude");
        fs::write(claude, "fake command marker").unwrap();
        assert!(has_file(home_candidates));

        #[cfg(windows)]
        let npm_claude = prefix.join("bin").join("claude.cmd");
        #[cfg(not(windows))]
        let npm_claude = prefix.join("bin").join("claude");
        fs::write(npm_claude, "fake npm command marker").unwrap();
        assert!(has_file(prefix_candidates));

        // A matching directory must not count as an installed command.
        let directory_only = root.0.join("directory-only");
        fs::create_dir_all(&directory_only).unwrap();
        #[cfg(windows)]
        let name = "codex.exe";
        #[cfg(not(windows))]
        let name = "codex";
        fs::create_dir(directory_only.join(name)).unwrap();
        let directory_candidates = command_candidates(
            "codex",
            Some(OsStr::new(directory_only.to_str().unwrap())),
            None,
            None,
            None,
        );
        assert!(!has_file(directory_candidates));
    }
}
