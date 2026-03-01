use serde_json::Map;
use serde_json::Number;
use serde_json::Value;
use std::env;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use crate::auth::extract_codex_oauth_tokens;
use crate::utils::set_private_permissions;

const FALLBACK_EXPIRES_IN_MS: i64 = 55 * 60 * 1000;

/// 同步 opencode 的 OpenAI 认证（openai.access/openai.refresh）。
///
/// 会自动探测：
/// 1. opencode 可执行文件位置（用于确认已安装）
/// 2. opencode 认证文件 `auth.json` 的位置
pub(crate) fn sync_openai_auth_from_codex_auth(auth_json: &Value) -> Result<(), String> {
    let tokens = extract_codex_oauth_tokens(auth_json)?;
    let install_path = detect_opencode_install_path();
    let auth_path = detect_opencode_auth_path();

    if install_path.is_none() && auth_path.is_none() {
        return Err("未检测到 opencode 安装位置或认证文件".to_string());
    }

    let auth_path = auth_path.ok_or_else(|| "未能定位 opencode 认证文件路径".to_string())?;
    let mut root = read_or_init_json_object(&auth_path)?;

    let expires_ms = tokens
        .expires_at_ms
        .unwrap_or_else(|| now_unix_millis().saturating_add(FALLBACK_EXPIRES_IN_MS));
    let mut openai = root
        .get("openai")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    // 保留既有类型；若不存在则补默认值。
    let auth_type = openai
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("oauth")
        .to_string();
    openai.insert("type".to_string(), Value::String(auth_type));
    openai.insert("access".to_string(), Value::String(tokens.access_token));
    openai.insert("refresh".to_string(), Value::String(tokens.refresh_token));
    openai.insert(
        "expires".to_string(),
        Value::Number(Number::from(expires_ms)),
    );
    if let Some(account_id) = tokens.account_id {
        openai.insert("accountId".to_string(), Value::String(account_id));
    }

    root.insert("openai".to_string(), Value::Object(openai));
    write_json_object(&auth_path, &root)?;
    Ok(())
}

fn detect_opencode_install_path() -> Option<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();

    if let Some(path_os) = env::var_os("PATH") {
        for dir in env::split_paths(&path_os) {
            candidates.push(dir.join("opencode"));
            #[cfg(windows)]
            {
                candidates.push(dir.join("opencode.exe"));
                candidates.push(dir.join("opencode.cmd"));
                candidates.push(dir.join("opencode.bat"));
            }
        }
    }

    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".opencode").join("bin").join("opencode"));
        candidates.push(home.join(".local").join("bin").join("opencode"));
        #[cfg(windows)]
        {
            candidates.push(home.join(".opencode").join("bin").join("opencode.exe"));
        }
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/opencode"));
        candidates.push(PathBuf::from("/usr/local/bin/opencode"));
    }

    candidates.into_iter().find(|path| is_executable_file(path))
}

fn detect_opencode_auth_path() -> Option<PathBuf> {
    if let Some(custom) = env::var_os("OPENCODE_AUTH_PATH").map(PathBuf::from) {
        return Some(custom);
    }

    let mut candidates = Vec::<PathBuf>::new();

    if let Some(xdg_data_home) = env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
        candidates.push(xdg_data_home.join("opencode").join("auth.json"));
    }
    #[cfg(windows)]
    if let Some(app_data) = env::var_os("APPDATA").map(PathBuf::from) {
        candidates.push(app_data.join("opencode").join("auth.json"));
    }

    if let Some(home) = dirs::home_dir() {
        candidates.push(
            home.join(".local")
                .join("share")
                .join("opencode")
                .join("auth.json"),
        );
        candidates.push(
            home.join("Library")
                .join("Application Support")
                .join("opencode")
                .join("auth.json"),
        );
        candidates.push(home.join(".config").join("opencode").join("auth.json"));
        candidates.push(home.join(".opencode").join("auth.json"));
    }

    if let Some(found) = candidates.iter().find(|path| path.exists()) {
        return Some(found.clone());
    }

    candidates.into_iter().next()
}

fn read_or_init_json_object(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }

    let raw = fs::read_to_string(path)
        .map_err(|e| format!("读取 opencode auth.json 失败 {}: {e}", path.display()))?;
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|e| format!("opencode auth.json 格式无效: {e}"))?;
    Ok(parsed.as_object().cloned().unwrap_or_default())
}

fn write_json_object(path: &Path, value: &Map<String, Value>) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("无法解析 opencode auth 目录 {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("创建 opencode auth 目录失败 {}: {e}", parent.display()))?;

    let content = serde_json::to_string_pretty(&Value::Object(value.clone()))
        .map_err(|e| format!("序列化 opencode auth.json 失败: {e}"))?;
    fs::write(path, content)
        .map_err(|e| format!("写入 opencode auth.json 失败 {}: {e}", path.display()))?;
    set_private_permissions(path);
    Ok(())
}

fn now_unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}
