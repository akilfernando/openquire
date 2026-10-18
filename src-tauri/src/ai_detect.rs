use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
#[allow(unused_imports)]
use std::path::{Path, PathBuf};

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
            paths.push(
                PathBuf::from(appdata)
                    .join("Claude")
                    .join("claude_desktop_config.json"),
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = home_dir() {
            paths.push(
                home.join("Library")
                    .join("Application Support")
                    .join("Claude")
                    .join("claude_desktop_config.json"),
            );
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(config_home) = std::env::var_os("XDG_CONFIG_HOME") {
            paths.push(
                PathBuf::from(config_home)
                    .join("Claude")
                    .join("claude_desktop_config.json"),
            );
        } else if let Some(home) = home_dir() {
            paths.push(
                home.join(".config")
                    .join("Claude")
                    .join("claude_desktop_config.json"),
            );
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
            let exe = PathBuf::from(&local)
                .join("Programs")
                .join("Claude")
                .join("Claude.exe");
            if exe.exists()
                || PathBuf::from(&local)
                    .join("AnthropicClaude/claude.exe")
                    .is_file()
            {
                return (true, configs.last().cloned(), false);
            }
            // Check Store package folder
            let store_dir = PathBuf::from(local)
                .join("Packages")
                .join("Claude_pzs8sxrjxfjjc");
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
            let exe = PathBuf::from(&local)
                .join("Programs")
                .join("ChatGPT")
                .join("ChatGPT.exe");
            if exe.exists() {
                return true;
            }
            // Check Windows packages
            let pkgs = PathBuf::from(&local).join("Packages");
            if let Ok(entries) = fs::read_dir(pkgs) {
                for entry in entries.flatten() {
                    if entry
                        .file_name()
                        .to_string_lossy()
                        .contains("OpenAI.ChatGPT")
                    {
                        return true;
                    }
                }
            }
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            if PathBuf::from(appdata)
                .join("OpenAI")
                .join("ChatGPT")
                .exists()
            {
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
        codex_cli: codex_status(),
        claude_code: cli_status("Claude Code", "claude"),
    }
}

const MCP_PACKAGE: &str = "https://github.com/akilfernando/openquire/releases/download/desktop-v0.2.0-rc.1/openquire-1.0.3.tgz";

fn codex_config_path(custom_home: Option<&Path>, home: Option<&Path>) -> Result<PathBuf, String> {
    let root = match custom_home {
        Some(path) if path.is_absolute() => path.to_path_buf(),
        Some(_) => return Err("CODEX_HOME must be an absolute directory.".into()),
        None => home
            .ok_or("Cannot determine the Codex configuration directory.")?
            .join(".codex"),
    };
    if !root.is_absolute() {
        return Err("Codex configuration directory must be absolute.".into());
    }
    Ok(root.join("config.toml"))
}

fn current_codex_config_path() -> Result<PathBuf, String> {
    let custom = std::env::var_os("CODEX_HOME").map(PathBuf::from);
    codex_config_path(custom.as_deref(), home_dir().as_deref())
}

fn codex_status() -> AssistantStatus {
    let mut status = cli_status("Codex CLI", "codex");
    match current_codex_config_path() {
        Ok(path) => {
            status.config_path = Some(path.to_string_lossy().into_owned());
            if reject_symlinks(&path).is_ok() {
                status.linked = fs::read_to_string(&path)
                    .ok()
                    .and_then(|s| s.parse::<toml_edit::DocumentMut>().ok())
                    .is_some_and(|doc| {
                        doc.get("mcp_servers")
                            .and_then(|s| s.get("openquire"))
                            .is_some_and(|s| {
                                s.is_table_like()
                                    && s.get("url").is_none()
                                    && s.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true)
                                    && s.get("command").and_then(|v| v.as_str()).is_some()
                            })
                    });
                if status.linked {
                    status.details = Some("OpenQuire MCP setup saved. Restart Codex and check its tools to verify the connection.".into());
                }
            }
        }
        Err(error) => status.details = Some(error),
    }
    status
}

/// Saves a folder-scoped local MCP entry; it does not start or authenticate Codex.
pub fn link_codex(allowed_dir: Option<String>) -> Result<String, String> {
    let folder = allowed_folder(allowed_dir)?;
    if find_command("codex").is_none() {
        return Err("Codex CLI was not found. Install Codex and restart OpenQuire.".into());
    }
    let (node, npx) = runtime_paths()?;
    let target = current_codex_config_path()?;
    let _lock = CONFIG_LOCK
        .lock()
        .map_err(|_| "Configuration update interrupted; restart OpenQuire.")?;
    link_codex_at(&target, &node, &npx, &folder)?;
    Ok(target.to_string_lossy().into_owned())
}

fn link_codex_at(target: &Path, node: &Path, npx: &Path, folder: &Path) -> Result<(), String> {
    use toml_edit::{value, Array, DocumentMut, Item, Table};
    reject_symlinks(target)?;
    let original = read_config(target)?;
    let text = original
        .as_deref()
        .map(std::str::from_utf8)
        .transpose()
        .map_err(|_| "Codex configuration must be UTF-8; unchanged.")?
        .unwrap_or("");
    let mut doc = text
        .parse::<DocumentMut>()
        .map_err(|_| "Codex configuration contains invalid TOML; unchanged.")?;
    if !doc.contains_key("mcp_servers") {
        doc["mcp_servers"] = Item::Table(Table::new());
    }
    let servers = doc["mcp_servers"]
        .as_table_like_mut()
        .ok_or("Codex mcp_servers must be a table; unchanged.")?;
    if !servers.contains_key("openquire") {
        servers.insert("openquire", Item::Table(Table::new()));
    }
    let entry = servers
        .get_mut("openquire")
        .and_then(Item::as_table_like_mut)
        .ok_or("Codex openquire entry must be a table; unchanged.")?;
    if entry.contains_key("url") {
        return Err("Codex already has a remote OpenQuire server. Remove or rename it explicitly before connecting locally.".into());
    }
    for (key, valid) in [
        (
            "command",
            entry.get("command").is_none_or(|v| v.as_str().is_some()),
        ),
        (
            "args",
            entry.get("args").is_none_or(|v| {
                v.as_array()
                    .is_some_and(|a| a.iter().all(|v| v.as_str().is_some()))
            }),
        ),
        (
            "enabled",
            entry.get("enabled").is_none_or(|v| v.as_bool().is_some()),
        ),
        (
            "startup_timeout_sec",
            entry
                .get("startup_timeout_sec")
                .is_none_or(|v| v.as_integer().is_some() || v.as_float().is_some()),
        ),
    ] {
        if !valid {
            return Err(format!(
                "Codex OpenQuire {key} has an invalid type; unchanged."
            ));
        }
    }
    entry.insert(
        "command",
        value(node.to_str().ok_or("Node.js path must be UTF-8")?),
    );
    let mut args = Array::new();
    for arg in [
        npx.to_str().ok_or("npm path must be UTF-8")?,
        "-y",
        MCP_PACKAGE,
        "mcp",
        "--allow-dir",
        folder.to_str().ok_or("Folder must be UTF-8")?,
    ] {
        args.push(arg);
    }
    entry.insert("args", value(args));
    entry.insert("enabled", value(true));
    if !entry.contains_key("startup_timeout_sec") {
        entry.insert("startup_timeout_sec", value(120));
    }
    fs::create_dir_all(target.parent().ok_or("Invalid Codex configuration path")?)
        .map_err(|e| e.to_string())?;
    save_config(target, doc.to_string().as_bytes(), original.as_deref())
}

static NEXT_CONFIG: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn allowed_folder(dir: Option<String>) -> Result<PathBuf, String> {
    let path = PathBuf::from(
        dir.filter(|s| !s.trim().is_empty())
            .ok_or("Choose an existing folder explicitly before connecting.")?,
    );
    if !path.is_absolute() || !path.is_dir() {
        return Err("The allowed folder must be an existing absolute directory.".into());
    }
    fs::canonicalize(path).map_err(|e| e.to_string())
}

fn supported_node(version: &str) -> bool {
    version
        .trim()
        .strip_prefix('v')
        .and_then(|v| v.split('.').next())
        .and_then(|v| v.parse::<u32>().ok())
        .is_some_and(|v| v >= 20)
}

fn runtime_paths() -> Result<(PathBuf, PathBuf), String> {
    let node = find_command("node").ok_or(
        "Node.js 20 or newer with npm is required. Install Node.js and restart OpenQuire.",
    )?;
    #[cfg(windows)]
    if !node
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
    {
        return Err("Node.js executable was not found.".into());
    }
    let node = fs::canonicalize(node).map_err(|e| e.to_string())?;
    let mut candidates = vec![node
        .parent()
        .ok_or("Invalid Node.js location")?
        .join("node_modules/npm/bin/npx-cli.js")];
    #[cfg(not(windows))]
    if let Some(npx) = find_command("npx").and_then(|p| fs::canonicalize(p).ok()) {
        candidates.push(npx);
    }
    #[cfg(windows)]
    if let Some(npx) = find_command("npx") {
        if let Some(parent) = npx.parent() {
            candidates.push(parent.join("node_modules/npm/bin/npx-cli.js"));
        }
    }
    let npx = candidates
        .into_iter()
        .find(|p| p.is_file() && p.file_name().is_some_and(|n| n == "npx-cli.js"))
        .ok_or("Cannot locate npm's npx-cli.js. Install Node.js 20 or newer with npm.")?;
    verify_node(&node)?;
    Ok((node, fs::canonicalize(npx).map_err(|e| e.to_string())?))
}

fn verify_node(node: &Path) -> Result<(), String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let temp = std::env::temp_dir().join(format!(
        "openquire-node-{}-{}.version",
        std::process::id(),
        NEXT_CONFIG.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let mut command = Command::new(node);
        command
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::from(file))
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start Node.js: {e}"))?;
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let version = fs::read_to_string(&temp).map_err(|e| e.to_string())?;
                    return if status.success() && supported_node(&version) {
                        Ok(())
                    } else {
                        Err("Node.js 20 or newer is required. Update Node.js and restart OpenQuire.".into())
                    };
                }
                Ok(None) if start.elapsed() < Duration::from_secs(5) => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                other => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "Node.js prerequisite check failed or timed out: {other:?}"
                    ));
                }
            }
        }
    })();
    let _ = fs::remove_file(temp);
    result
}

fn reject_symlinks(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("Assistant configuration paths must not contain symbolic links.".into())
            }
            Ok(meta) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err(
                            "Assistant configuration paths must not contain reparse points.".into(),
                        );
                    }
                }
                #[cfg(not(windows))]
                let _ = meta;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

fn read_config(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn save_config(path: &Path, bytes: &[u8], original: Option<&[u8]>) -> Result<(), String> {
    use std::io::Write;
    if let Some(original) = original {
        let backup = path.with_file_name(format!(
            "{}.openquire-{}-{}.bak",
            path.file_name()
                .ok_or("Missing configuration filename")?
                .to_string_lossy(),
            std::process::id(),
            NEXT_CONFIG.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut backup = options
            .open(backup)
            .map_err(|e| format!("Cannot back up assistant configuration: {e}"))?;
        backup
            .write_all(original)
            .and_then(|_| backup.sync_all())
            .map_err(|e| e.to_string())?;
    }
    reject_symlinks(path)?;
    if read_config(path)?.as_deref() != original {
        return Err(
            "Assistant configuration changed during connection. Retry after other editors finish."
                .into(),
        );
    }
    crate::file_save::write_atomic(path, bytes)
        .map_err(|e| format!("Cannot save assistant configuration: {e}"))
}

/// Links Claude Desktop to OpenQuire by updating claude_desktop_config.json
pub fn link_claude(allowed_dir: Option<String>) -> Result<String, String> {
    let dir = allowed_folder(allowed_dir)?;
    let (node, npx) = runtime_paths()?;
    let _lock = CONFIG_LOCK
        .lock()
        .map_err(|_| "Configuration update interrupted; restart OpenQuire.")?;
    let paths = claude_config_paths();
    #[cfg(windows)]
    let fallback = {
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or("Cannot locate Claude installation")?;
        let normal = local.join("Programs/Claude/Claude.exe").is_file()
            || local.join("AnthropicClaude/claude.exe").is_file();
        let store = local.join("Packages/Claude_pzs8sxrjxfjjc").is_dir();
        match (normal, store) {
            (true, false) => paths.last(),
            (false, true) => paths.first(),
            _ => None,
        }
    };
    #[cfg(target_os = "macos")]
    let fallback = paths
        .iter()
        .find(|p| p.parent().is_some_and(|d| d.is_dir()))
        .or_else(|| {
            if Path::new("/Applications/Claude.app").is_dir() {
                paths.first()
            } else {
                None
            }
        });
    #[cfg(not(any(windows, target_os = "macos")))]
    let fallback = paths
        .iter()
        .find(|p| p.parent().is_some_and(|d| d.is_dir()));
    let target = paths
        .iter()
        .find(|p| p.exists())
        .or(fallback)
        .ok_or_else(|| "Could not determine Claude Desktop configuration directory".to_string())?;

    if paths.iter().filter(|p| p.exists()).count() > 1 {
        return Err("Multiple Claude configurations exist; resolve the installation ambiguity before connecting.".into());
    }
    link_at(target, &node, &npx, &dir)?;
    Ok(target.to_string_lossy().into_owned())
}

fn link_at(target: &Path, node: &Path, npx: &Path, dir: &Path) -> Result<(), String> {
    reject_symlinks(target)?;
    let parent = target.parent().ok_or("Invalid configuration path")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let original = read_config(target)?;
    let mut config: Value = match &original {
        Some(content) => serde_json::from_slice(content)
            .map_err(|e| format!("Invalid Claude configuration JSON; unchanged: {e}"))?,
        None => json!({}),
    };

    let dir = dir
        .to_str()
        .ok_or("Folder must be valid UTF-8")?
        .to_string();

    let cmd = node.to_str().ok_or("Node.js path must be valid UTF-8")?;
    let args = vec![
        npx.to_str()
            .ok_or("npm path must be valid UTF-8")?
            .to_string(),
        "-y".into(),
        MCP_PACKAGE.into(),
        "mcp".into(),
        "--allow-dir".into(),
        dir,
    ];

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
    } else {
        return Err("Claude mcpServers must be a JSON object; unchanged.".into());
    }

    let formatted = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    save_config(target, (formatted + "\n").as_bytes(), original.as_deref())?;

    Ok(())
}

/// Unlinks OpenQuire from Claude Desktop
pub fn unlink_claude() -> Result<(), String> {
    for p in claude_config_paths() {
        if !p.exists() {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&p) {
            if let Ok(mut config) = serde_json::from_str::<Value>(&content) {
                if let Some(servers) = config.get_mut("mcpServers").and_then(|s| s.as_object_mut())
                {
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
    use super::{allowed_folder, link_at, read_config, save_config, supported_node, MCP_PACKAGE};
    use super::{codex_config_path, link_codex_at};
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

    /// Produces isolated real-runtime configurations for the manual CLI/MCP contract smoke.
    /// The caller supplies a fresh directory; existing paths are never reused.
    #[test]
    #[ignore = "requires installed Node/npm and an explicit fresh smoke directory"]
    fn export_connection_smoke_configs() {
        let root = std::path::PathBuf::from(
            std::env::var_os("OPENQUIRE_CONNECTION_SMOKE_DIR")
                .expect("fresh smoke directory required"),
        );
        assert!(root.is_absolute());
        fs::create_dir(&root).unwrap();
        let folder = root.join("PDFs & notes");
        fs::create_dir(&folder).unwrap();
        let (node, npx) = super::runtime_paths().unwrap();
        super::link_at(&root.join("claude.json"), &node, &npx, &folder).unwrap();
        super::link_codex_at(&root.join("codex/config.toml"), &node, &npx, &folder).unwrap();
    }

    fn has_file(candidates: Vec<std::path::PathBuf>) -> bool {
        candidates.into_iter().any(|candidate| candidate.is_file())
    }

    #[test]
    fn codex_home_resolution_is_explicit_and_absolute() {
        let root = TestDir::new();
        assert_eq!(
            codex_config_path(None, Some(&root.0)).unwrap(),
            root.0.join(".codex/config.toml")
        );
        let custom = root.0.join("custom codex");
        assert_eq!(
            codex_config_path(Some(&custom), None).unwrap(),
            custom.join("config.toml")
        );
        assert!(codex_config_path(Some(Path::new("relative")), Some(&root.0)).is_err());
        assert!(codex_config_path(None, None).is_err());
    }

    #[test]
    fn codex_rejects_invalid_toml_types_and_remote_conflicts_without_writes() {
        let root = TestDir::new();
        let target = root.0.join("config.toml");
        for bytes in [
            b"invalid [".as_slice(),
            b"\xff",
            b"mcp_servers = 2",
            b"[mcp_servers]\nopenquire = 3",
            b"[mcp_servers.openquire]\nurl = 'https://example.com/mcp'",
            b"[mcp_servers.openquire]\ncommand = 3",
            b"[mcp_servers.openquire]\nargs = [3]",
            b"[mcp_servers.openquire]\nenabled = 'false'",
            b"[mcp_servers.openquire]\nstartup_timeout_sec = '120'",
        ] {
            fs::write(&target, bytes).unwrap();
            assert!(
                link_codex_at(&target, Path::new("node"), Path::new("npx-cli.js"), &root.0)
                    .is_err()
            );
            assert_eq!(fs::read(&target).unwrap(), bytes);
        }
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);
    }

    #[test]
    fn codex_preserves_comments_policies_other_servers_and_literal_arguments() {
        let root = TestDir::new();
        let target = root.0.join("config.toml");
        let original = b"# personal settings\nmodel = 'example'\napproval_policy = 'on-request'\n[mcp_servers.other]\ncommand = 'keep' # retain this\n[mcp_servers.openquire]\nenabled = false\nstartup_timeout_sec = 45\nenabled_tools = ['read_pdf']\n[ mcp_servers.openquire.env ]\nCUSTOM = 'preserve'\n";
        fs::write(&target, original).unwrap();
        let folder = root.0.join("space & % ! ' folder");
        let node = root.0.join("node.exe");
        let npx = root.0.join("npm path/npx-cli.js");
        link_codex_at(&target, &node, &npx, &folder).unwrap();
        let text = fs::read_to_string(&target).unwrap();
        assert!(text.contains("# personal settings"));
        assert!(text.contains("# retain this"));
        let doc = text.parse::<toml_edit::DocumentMut>().unwrap();
        assert_eq!(doc["approval_policy"].as_str(), Some("on-request"));
        assert_eq!(
            doc["mcp_servers"]["other"]["command"].as_str(),
            Some("keep")
        );
        let entry = &doc["mcp_servers"]["openquire"];
        assert_eq!(entry["command"].as_str(), node.to_str());
        assert_eq!(entry["enabled"].as_bool(), Some(true));
        assert_eq!(entry["startup_timeout_sec"].as_integer(), Some(45));
        assert_eq!(entry["enabled_tools"][0].as_str(), Some("read_pdf"));
        assert_eq!(entry["env"]["CUSTOM"].as_str(), Some("preserve"));
        let args = entry["args"].as_array().unwrap();
        assert_eq!(args.len(), 6);
        assert_eq!(args.get(0).unwrap().as_str(), npx.to_str());
        assert_eq!(args.get(2).unwrap().as_str(), Some(MCP_PACKAGE));
        assert_eq!(args.get(5).unwrap().as_str(), folder.to_str());
        let backup = fs::read_dir(&root.0)
            .unwrap()
            .flatten()
            .find(|e| e.path().extension().is_some_and(|s| s == "bak"))
            .unwrap();
        assert!(backup
            .file_name()
            .to_string_lossy()
            .starts_with("config.toml.openquire-"));
        assert_eq!(fs::read(backup.path()).unwrap(), original);
    }

    #[test]
    fn codex_inline_tables_preserve_other_entries_and_allow_new_local_setup() {
        let root = TestDir::new();
        let target = root.0.join("config.toml");
        for original in [
            "mcp_servers = { other = { command = 'keep' } } # keep inline comment\n",
            "mcp_servers = { other = { command = 'keep' }, openquire = { command = 'old', enabled = false, enabled_tools = ['read_pdf'] } } # keep inline comment\n",
            "[mcp_servers]\nother = { command = 'keep' }\nopenquire = { command = 'old', enabled = false, enabled_tools = ['read_pdf'] }\n",
        ] {
            fs::write(&target, original).unwrap();
            link_codex_at(&target, &root.0.join("node.exe"), &root.0.join("npx-cli.js"), &root.0).unwrap();
            let text = fs::read_to_string(&target).unwrap();
            let doc = text.parse::<toml_edit::DocumentMut>().unwrap();
            assert_eq!(doc["mcp_servers"]["other"]["command"].as_str(), Some("keep"));
            assert_eq!(doc["mcp_servers"]["openquire"]["enabled"].as_bool(), Some(true));
            assert_eq!(doc["mcp_servers"]["openquire"]["args"].as_array().unwrap().get(2).unwrap().as_str(), Some(MCP_PACKAGE));
            if original.contains("enabled_tools") {
                assert_eq!(doc["mcp_servers"]["openquire"]["enabled_tools"][0].as_str(), Some("read_pdf"));
            }
            if original.contains("# keep inline comment") { assert!(text.contains("# keep inline comment")); }
        }
    }

    #[test]
    fn codex_new_config_uses_default_startup_timeout() {
        let root = TestDir::new();
        let target = root.0.join("nested/config.toml");
        link_codex_at(&target, Path::new("node"), Path::new("npx-cli.js"), &root.0).unwrap();
        let doc = fs::read_to_string(&target)
            .unwrap()
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        assert_eq!(
            doc["mcp_servers"]["openquire"]["startup_timeout_sec"].as_integer(),
            Some(120)
        );
    }

    #[test]
    fn connection_requires_explicit_existing_absolute_scope_and_node_20() {
        assert!(allowed_folder(None).is_err());
        assert!(allowed_folder(Some("relative".into())).is_err());
        let root = TestDir::new();
        assert_eq!(
            allowed_folder(Some(root.0.to_str().unwrap().into())).unwrap(),
            fs::canonicalize(&root.0).unwrap()
        );
        assert!(!supported_node("v18.20.4"));
        assert!(!supported_node("garbage"));
        assert!(supported_node("v20.0.0\n"));
        assert!(supported_node("v24.3.1"));
    }

    #[test]
    fn malformed_or_nonobject_configs_are_preserved_exactly() {
        let root = TestDir::new();
        let target = root.0.join("config.json");
        for bytes in [
            "{bad",
            "[]",
            "null",
            "{\"mcpServers\":[]}",
            "{\"mcpServers\":null}",
        ] {
            fs::write(&target, bytes).unwrap();
            assert!(link_at(&target, Path::new("node"), Path::new("npx-cli.js"), &root.0).is_err());
            assert_eq!(fs::read_to_string(&target).unwrap(), bytes);
        }
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);
    }

    #[test]
    fn connection_preserves_entries_backs_up_original_and_keeps_args_literal() {
        let root = TestDir::new();
        let target = root.0.join("config.json");
        let original = br#"{"theme":"dark","mcpServers":{"other":{"command":"keep"},"openquire":{"command":"old"}}}"#;
        fs::write(&target, original).unwrap();
        let folder = root.0.join("space & % ! ' folder");
        fs::create_dir(&folder).unwrap();
        link_at(
            &target,
            &root.0.join("node.exe"),
            &root.0.join("npx-cli.js"),
            &folder,
        )
        .unwrap();
        let config: serde_json::Value =
            serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
        assert_eq!(config["theme"], "dark");
        assert_eq!(config["mcpServers"]["other"]["command"], "keep");
        let entry = &config["mcpServers"]["openquire"];
        assert_eq!(entry["command"], root.0.join("node.exe").to_str().unwrap());
        assert_eq!(entry["args"][2], MCP_PACKAGE);
        assert_eq!(entry["args"][5], folder.to_str().unwrap());
        let backup = fs::read_dir(&root.0)
            .unwrap()
            .flatten()
            .find(|e| e.path().extension().is_some_and(|s| s == "bak"))
            .unwrap();
        assert_eq!(fs::read(backup.path()).unwrap(), original);
        let stale = read_config(&target).unwrap();
        fs::write(&target, "concurrent edit").unwrap();
        assert!(save_config(&target, b"replacement", stale.as_deref()).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"concurrent edit");
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
