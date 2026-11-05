#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{Emitter, Manager};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpRequest {
    method: String,
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    body: Option<String>,
    body_base64: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Serialize)]
struct HttpResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
    body_base64: String,
}

fn state_path(app: &tauri::AppHandle, key: &str) -> Result<PathBuf, String> {
    if key.is_empty()
        || key.len() > 200
        || key.contains("..")
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err("invalid state key".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(dir.join(format!("{key}.json")))
}

#[tauri::command]
async fn state_load(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let path = state_path(&app, &key)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {key}: {e}")),
    }
}

#[tauri::command]
async fn state_save(app: tauri::AppHandle, key: String, json: String) -> Result<(), String> {
    let path = state_path(&app, &key)?;
    let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("write {key}: {e}"))?;
    if let Err(first) = fs::rename(&tmp, &path) {
        // Windows refuses rename-over-existing; replace explicitly.
        let _ = fs::remove_file(&path);
        fs::rename(&tmp, &path).map_err(|e| format!("replace {key}: {e} (first: {first})"))?;
    }
    let _ = app.emit("state-saved", &key);
    Ok(())
}

/// Brings the main window forward and asks the React shell to open one note.
#[tauri::command]
async fn open_note(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is missing".to_string())?;
    window.show().map_err(|e| format!("show main: {e}"))?;
    window.set_focus().map_err(|e| format!("focus main: {e}"))?;
    window
        .emit("open-note", id)
        .map_err(|e| format!("emit open-note: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn state_delete(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let path = state_path(&app, &key)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete {key}: {e}")),
    }
}

#[tauri::command]
async fn http_request(req: HttpRequest) -> Result<HttpResponse, String> {
    let url = reqwest::Url::parse(&req.url).map_err(|e| format!("invalid url: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("only http/https requests are allowed".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(req.timeout_ms.unwrap_or(180_000)))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|e| format!("invalid method: {e}"))?;
    let mut builder = client.request(method, url);
    for (name, value) in req.headers {
        builder = builder.header(name, value);
    }
    if let Some(b64) = req.body_base64 {
        let bytes = STANDARD
            .decode(b64)
            .map_err(|e| format!("invalid body_base64: {e}"))?;
        builder = builder.body(bytes);
    } else if let Some(body) = req.body {
        builder = builder.body(body);
    }
    let resp = builder.send().await.map_err(|e| format!("request: {e}"))?;
    let status = resp.status().as_u16();
    let headers: HashMap<String, String> = resp
        .headers()
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|s| (k.to_string(), s.to_string())))
        .collect();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read body: {e}"))?;
    Ok(HttpResponse {
        status,
        headers,
        body: String::from_utf8_lossy(&bytes).to_string(),
        body_base64: STANDARD.encode(&bytes),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            state_load,
            state_save,
            state_delete,
            open_note,
            http_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running NoneNote");
}
