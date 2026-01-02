#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use std::fs;
use std::path::Path;
use std::io::{Write, Read};
use std::thread;
use std::panic;
use std::sync::{Mutex, OnceLock, Arc};
use std::process::{Child, Command, Stdio};
use std::collections::HashMap;
use tauri::{command, AppHandle, Manager, CustomMenuItem, Menu, MenuItem, Submenu, WindowMenuEvent, State};
use walkdir::WalkDir;
use docx_rs::*;
use calamine::{Reader, open_workbook, Xlsx};
use image::GenericImageView;
use base64::Engine;
use serde::{Deserialize, Serialize};
#[cfg(not(unix))]
use zip::ZipArchive;
use flate2::read::GzDecoder;
use tar::Archive;

// Managed LLM Server types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedLLMServerInfo {
    pub status: String, // "not_downloaded" | "downloaded" | "running" | "stopped" | "error"
    pub version: Option<String>,
    pub path: Option<String>,
    pub port: Option<u16>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedLLMConfig {
    pub port: u16,
    pub host: String,
    pub model: Option<String>,
    pub model_filename: Option<String>,
    pub model_path: Option<String>,
    pub log_level: String,
    pub env_vars: HashMap<String, String>,
    pub mmproj_repo_id: Option<String>,
    pub mmproj_filename: Option<String>,
    pub chat_format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ServerProcessInfo {
    pid: u32,
    config: ManagedLLMConfig,
}

// Global state for the managed LLM server process and its config
// Stores: Optional Child handle (None if orphaned), and ServerProcessInfo with PID and config
type ManagedLLMState = Arc<Mutex<Option<(Option<Child>, ServerProcessInfo)>>>;

// Helper functions for PID file management and process control

fn get_pid_file_path(app_data_dir: &std::path::PathBuf) -> std::path::PathBuf {
    app_data_dir.join("llm-server").join("server.pid")
}

fn write_pid_file(app_data_dir: &std::path::PathBuf, pid: u32, config: &ManagedLLMConfig) -> Result<(), String> {
    let pid_file = get_pid_file_path(app_data_dir);
    let pid_data = serde_json::json!({
        "pid": pid,
        "port": config.port,
        "host": config.host,
        "started_at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    });
    
    fs::write(&pid_file, pid_data.to_string())
        .map_err(|e| format!("Failed to write PID file: {}", e))?;
    
    eprintln!("Wrote PID {} to file: {}", pid, pid_file.to_string_lossy());
    Ok(())
}

fn read_pid_file(app_data_dir: &std::path::PathBuf) -> Option<(u32, u16, String)> {
    let pid_file = get_pid_file_path(app_data_dir);
    if !pid_file.exists() {
        return None;
    }
    
    let pid_data = fs::read_to_string(&pid_file).ok()?;
    let pid_json: serde_json::Value = serde_json::from_str(&pid_data).ok()?;
    
    let pid = pid_json["pid"].as_u64()? as u32;
    let port = pid_json["port"].as_u64()? as u16;
    let host = pid_json["host"].as_str()?.to_string();
    
    Some((pid, port, host))
}

fn remove_pid_file(app_data_dir: &std::path::PathBuf) {
    let pid_file = get_pid_file_path(app_data_dir);
    if pid_file.exists() {
        let _ = fs::remove_file(&pid_file);
        eprintln!("Removed PID file: {}", pid_file.to_string_lossy());
    }
}

#[cfg(target_os = "windows")]
fn is_process_running(pid: u32) -> bool {
    let output = std::process::Command::new("tasklist")
        .args(&["/FI", &format!("PID eq {}", pid), "/NH"])
        .output();
    
    if let Ok(output) = output {
        let output_str = String::from_utf8_lossy(&output.stdout);
        output_str.contains(&pid.to_string())
    } else {
        false
    }
}

#[cfg(unix)]
fn is_process_running(pid: u32) -> bool {
    // Use kill -0 to check if process exists without killing it
    std::process::Command::new("kill")
        .args(&["-0", &pid.to_string()])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn kill_process_by_pid(pid: u32) -> Result<(), String> {
    eprintln!("Killing process with PID: {}", pid);
    let output = std::process::Command::new("taskkill")
        .args(&["/F", "/T", "/PID", &pid.to_string()])
        .output()
        .map_err(|e| format!("Failed to execute taskkill: {}", e))?;
    
    if output.status.success() {
        eprintln!("Successfully killed process {}", pid);
        Ok(())
    } else {
        Err(format!("Failed to kill process: {}", String::from_utf8_lossy(&output.stderr)))
    }
}

#[cfg(target_os = "windows")]
fn kill_process_by_name(process_name: &str) -> Result<(), String> {
    eprintln!("Killing all processes with name: {}", process_name);
    let output = std::process::Command::new("taskkill")
        .args(&["/F", "/IM", process_name])
        .output()
        .map_err(|e| format!("Failed to execute taskkill: {}", e))?;
    
    if output.status.success() {
        eprintln!("Successfully killed processes named {}", process_name);
        Ok(())
    } else {
        // Don't treat as error if process not found
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("not found") {
            eprintln!("No processes found with name {}", process_name);
            Ok(())
        } else {
            Err(format!("Failed to kill process: {}", stderr))
        }
    }
}

#[cfg(unix)]
fn kill_process_by_pid(pid: u32) -> Result<(), String> {
    eprintln!("Killing process with PID: {}", pid);
    let output = std::process::Command::new("kill")
        .args(&["-9", &pid.to_string()])
        .output()
        .map_err(|e| format!("Failed to execute kill: {}", e))?;
    
    if output.status.success() {
        eprintln!("Successfully killed process {}", pid);
        Ok(())
    } else {
        Err(format!("Failed to kill process: {}", String::from_utf8_lossy(&output.stderr)))
    }
}

async fn try_reconnect_orphaned_server(
    app_data_dir: &std::path::PathBuf,
    state: &ManagedLLMState
) -> Result<(), String> {
    if let Some((pid, port, host)) = read_pid_file(app_data_dir) {
        eprintln!("Found PID file: PID={}, host={}, port={}", pid, host, port);
        
        // Check if process is still running
        if !is_process_running(pid) {
            eprintln!("Process {} is not running, cleaning up PID file", pid);
            remove_pid_file(app_data_dir);
            return Ok(());
        }
        
        // Verify it's actually our server by checking if it responds
        let client = reqwest::Client::new();
        let test_url = format!("http://{}:{}/v1/models", host, port);
        
        eprintln!("Verifying orphaned server at: {}", test_url);
        match client.get(&test_url)
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await 
        {
            Ok(response) if response.status().is_success() => {
                eprintln!("Orphaned server is responsive, reconnecting...");
                
                // Reconnect by storing process info without Child handle
                let config = ManagedLLMConfig {
                    port,
                    host,
                    model: None,
                    model_filename: None,
                    model_path: None,
                    log_level: "info".to_string(),
                    env_vars: HashMap::new(),
                    mmproj_repo_id: None,
                    mmproj_filename: None,
                    chat_format: None,
                };
                
                let process_info = ServerProcessInfo {
                    pid,
                    config,
                };
                
                let mut state_guard = state.lock().unwrap();
                *state_guard = Some((None, process_info)); // None = orphaned process
                
                eprintln!("Successfully reconnected to orphaned server");
                Ok(())
            }
            _ => {
                eprintln!("Process exists but server not responding, cleaning up");
                remove_pid_file(app_data_dir);
                Ok(())
            }
        }
    } else {
        Ok(()) // No PID file found
    }
}

// OS-specific files to skip
const OS_SPECIFIC_FILES: &[&str] = &[
    ".DS_Store", ".ds_store",
    "Thumbs.db", "thumbs.db",
    "desktop.ini", "Desktop.ini",
    ".Spotlight-V100", ".Trashes", ".fseventsd",
    "ehthumbs.db", "ehthumbs_vista.db",
    ".AppleDouble", ".LSOverride",
    "Icon\r", ".DocumentRevisions-V100", ".TemporaryItems",
    "$RECYCLE.BIN", "System Volume Information",
];

// OS-specific directories to skip
const OS_SPECIFIC_DIRS: &[&str] = &[
    ".Spotlight-V100", ".Trashes", ".fseventsd",
    ".DocumentRevisions-V100", ".TemporaryItems",
    "$RECYCLE.BIN", "System Volume Information",
    "__MACOSX", ".AppleDouble",
];

fn is_hidden_or_os_file(name: &str) -> bool {
    name.starts_with('.') || OS_SPECIFIC_FILES.contains(&name)
}

fn is_hidden_or_os_dir(name: &str) -> bool {
    name.starts_with('.') || OS_SPECIFIC_DIRS.contains(&name)
}

#[command]
async fn read_directory(path: String, include_subdirectories: bool) -> Result<Vec<String>, String> {
    if include_subdirectories {
        let entries = WalkDir::new(&path)
            .into_iter()
            .filter_entry(|e| {
                // Skip hidden directories and OS-specific directories
                let name = e.file_name().to_string_lossy();
                !is_hidden_or_os_dir(&name)
            })
            .filter_map(|e| e.ok())
            .filter(|e| {
                if !e.path().is_file() {
                    return false;
                }
                let name = e.file_name().to_string_lossy();
                !is_hidden_or_os_file(&name)
            })
            .map(|e| e.path().to_string_lossy().into_owned())
            .collect::<Vec<String>>();
        Ok(entries)
    } else {
        let entries = fs::read_dir(path)
            .map_err(|e| e.to_string())?
            .filter_map(|res| res.ok())
            .filter(|entry| {
                if !entry.path().is_file() {
                    return false;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                !is_hidden_or_os_file(&name)
            })
            .map(|e| e.path().to_string_lossy().into_owned())
            .collect::<Vec<String>>();
        Ok(entries)
    }
}

#[command]
async fn list_subdirectories(path: String) -> Result<Vec<String>, String> {
    let base_path = Path::new(&path);
    let entries: Vec<String> = WalkDir::new(&path)
        .min_depth(1) // Skip the root directory itself
        .into_iter()
        .filter_entry(|e| {
            // Skip hidden directories and OS-specific directories
            let name = e.file_name().to_string_lossy();
            !is_hidden_or_os_dir(&name)
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|entry| {
            // Get relative path from the base directory
            entry.path().strip_prefix(base_path).ok().map(|rel| {
                rel.to_string_lossy().to_string()
            })
        })
        .collect();
    Ok(entries)
}

#[command]
async fn http_request(
    url: String,
    method: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    
    let mut request = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => return Err(format!("Unsupported HTTP method: {}", method)),
    };

    // Add headers
    for (key, value) in headers {
        request = request.header(key, value);
    }

    // Add body if present
    if let Some(body_content) = body {
        request = request.body(body_content);
    }

    // Execute request
    let response = request
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    // Get status for error handling
    let status = response.status();
    
    // Get response text
    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), text));
    }

    Ok(text)
}

#[command]
async fn save_diagnostic_logs(content: String, filename: String) -> Result<String, String> {
    // Get the user's home directory
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?;
    
    // Create a path in the user's Downloads folder
    let downloads_dir = home_dir.join("Downloads");
    let file_path = downloads_dir.join(&filename);
    
    // Write the content to the file
    let mut file = fs::File::create(&file_path)
        .map_err(|e| format!("Failed to create file: {}", e))?;
    
    file.write_all(content.as_bytes())
        .map_err(|e| format!("Failed to write to file: {}", e))?;
    
    // Return the full path where the file was saved
    Ok(file_path.to_string_lossy().to_string())
}

static PANIC_HOOK_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn extract_pdf_text(path: &str) -> Result<String, String> {
    let owned_path = path.to_owned();
    let handle = thread::spawn(move || {
        let lock = PANIC_HOOK_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let original_hook = panic::take_hook();
        panic::set_hook(Box::new(|_| {}));
        let extraction_result = panic::catch_unwind(|| pdf_extract::extract_text(&owned_path));
        panic::set_hook(original_hook);
        drop(lock);
        extraction_result
    });

    match handle.join() {
        Ok(Ok(Ok(text))) => Ok(text),
        Ok(Ok(Err(e))) => Err(format!(
            "Failed to extract text from PDF: {}. This PDF may have complex fonts or encoding issues.",
            e
        )),
        Ok(Err(_)) | Err(_) => Err(
            "Failed to extract text from PDF: The PDF contains unsupported fonts or encoding that cannot be processed.".to_string(),
        ),
    }
}

fn extract_docx_text(path: &str) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|e| format!("Failed to open DOCX file: {}", e))?;
    
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)
        .map_err(|e| format!("Failed to read DOCX file: {}", e))?;
    
    let docx = read_docx(&buffer)
        .map_err(|e| format!("Failed to parse DOCX file: {}", e))?;
    
    // Extract text from paragraphs
    let mut text = String::new();
    for child in &docx.document.children {
        if let DocumentChild::Paragraph(para) = child {
            for child in &para.children {
                if let ParagraphChild::Run(run) = child {
                    for child in &run.children {
                        if let RunChild::Text(t) = child {
                            text.push_str(&t.text);
                            text.push(' ');
                        }
                    }
                }
            }
            text.push('\n');
        }
    }
    
    Ok(text)
}

fn extract_xlsx_text(path: &str) -> Result<String, String> {
    let mut workbook: Xlsx<_> = open_workbook(path)
        .map_err(|e| format!("Failed to open Excel file: {}", e))?;
    
    let mut text = String::new();
    
    // Iterate through all sheets
    for sheet_name in workbook.sheet_names().to_vec() {
        text.push_str(&format!("Sheet: {}\n", sheet_name));
        
        if let Ok(range) = workbook.worksheet_range(&sheet_name) {
            for row in range.rows() {
                for cell in row {
                    // Use get_string() method to convert cell to string
                    let cell_str = cell.to_string();
                    if !cell_str.is_empty() {
                        text.push_str(&cell_str);
                        text.push('\t');
                    }
                }
                text.push('\n');
            }
        }
        text.push('\n');
    }
    
    Ok(text)
}

fn encode_image_base64(path: &str) -> Result<String, String> {
    let img = image::open(path)
        .map_err(|e| format!("Failed to open image: {}", e))?;
    
    // Resize large images to reduce token usage
    let (width, height) = img.dimensions();
    let max_dimension = 1024;
    
    let resized_img = if width > max_dimension || height > max_dimension {
        let scale = max_dimension as f32 / width.max(height) as f32;
        let new_width = (width as f32 * scale) as u32;
        let new_height = (height as f32 * scale) as u32;
        img.resize(new_width, new_height, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    
    // Encode as JPEG for smaller size
    let mut buffer = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buffer);
    
    resized_img.write_to(&mut cursor, image::ImageFormat::Jpeg)
        .map_err(|e| format!("Failed to encode image: {}", e))?;
    
    Ok(base64::engine::general_purpose::STANDARD.encode(&buffer))
}

#[derive(serde::Serialize)]
struct FileContent {
    text: Option<String>,
    image_base64: Option<String>,
    mime_type: Option<String>,
}

#[command]
async fn read_file_content(path: String) -> Result<String, String> {
    let path_lower = path.to_lowercase();
    let content: FileContent;
    
    if path_lower.ends_with(".pdf") {
        // Extract text from PDF
        let text = extract_pdf_text(&path)?;
        content = FileContent {
            text: Some(text),
            image_base64: None,
            mime_type: Some("application/pdf".to_string()),
        };
    } else if path_lower.ends_with(".docx") {
        // Extract text from DOCX
        let text = extract_docx_text(&path)?;
        content = FileContent {
            text: Some(text),
            image_base64: None,
            mime_type: Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_string()),
        };
    } else if path_lower.ends_with(".doc") {
        // DOC files are not supported by docx-rs, treat as unsupported
        return Err("DOC format not supported. Please convert to DOCX.".to_string());
    } else if path_lower.ends_with(".xlsx") || path_lower.ends_with(".xls") {
        // Extract text from Excel
        let text = extract_xlsx_text(&path)?;
        content = FileContent {
            text: Some(text),
            image_base64: None,
            mime_type: Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string()),
        };
    } else if path_lower.ends_with(".png") || path_lower.ends_with(".jpg") || 
              path_lower.ends_with(".jpeg") || path_lower.ends_with(".gif") || 
              path_lower.ends_with(".bmp") || path_lower.ends_with(".webp") {
        // Encode image as base64
        let image_data = encode_image_base64(&path)?;
        let mime = if path_lower.ends_with(".png") {
            "image/png"
        } else if path_lower.ends_with(".jpg") || path_lower.ends_with(".jpeg") {
            "image/jpeg"
        } else if path_lower.ends_with(".gif") {
            "image/gif"
        } else if path_lower.ends_with(".bmp") {
            "image/bmp"
        } else if path_lower.ends_with(".webp") {
            "image/webp"
        } else {
            "image/jpeg"
        };
        
        content = FileContent {
            text: None,
            image_base64: Some(image_data),
            mime_type: Some(mime.to_string()),
        };
    } else {
        // Plain text file
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        content = FileContent {
            text: Some(text),
            image_base64: None,
            mime_type: Some("text/plain".to_string()),
        };
    }
    
    // Serialize as JSON
    serde_json::to_string(&content).map_err(|e| format!("Failed to serialize content: {}", e))
}

#[command]
async fn move_file(from: String, to: String) -> Result<(), String> {
    let to_path = Path::new(&to);
    if let Some(parent) = to_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_directory(_app: AppHandle) -> Result<Vec<String>, String> {
    use rfd::FileDialog;
    use std::path::PathBuf;

        // Open the dialog
    let folders: Option<Vec<PathBuf>> = FileDialog::new()
        .set_title("Select one or more directories")
        .pick_folders();

    // Handle the result
    match folders {
        Some(paths) => {
            if paths.is_empty() {
                // This case might happen if the dialog logic allows "OK" with no selection
                eprintln!("No directories were selected.");
                return Err("No directories selected".to_string());
            } else {
                eprintln!("You selected the following directories:");
                let strs: Vec<String> = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                for p in &strs {
                    eprintln!("- {}", p);
                }
                return Ok(strs);
            }
        }
        None => {
            // This happens if the user presses "Cancel" or closes the dialog
            eprintln!("Dialog was canceled. No directories selected.");
            return Err("User cancelled folder selection".to_string());
        }
    }
}

#[tauri::command]
async fn open_file(path: String) -> Result<(), String> {
    use std::process::Command;
    
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    
    Ok(())
}

// Managed LLM Server Commands

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppVersionInfo {
    pub version: String,
    pub build_timestamp: String,
}

#[command]
fn get_app_version() -> AppVersionInfo {
    AppVersionInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        build_timestamp: env!("BUILD_TIMESTAMP").to_string(),
    }
}

#[command]
async fn get_llm_server_status(app: AppHandle, state: State<'_, ManagedLLMState>) -> Result<ManagedLLMServerInfo, String> {
    let app_data_dir = app.path_resolver()
        .app_data_dir()
        .ok_or("Could not get app data directory")?;
    
    let server_dir = app_data_dir.join("llm-server");
    
    // Try multiple possible locations for the server executable
    let possible_paths = if cfg!(target_os = "windows") {
        vec![
            server_dir.join("llama_server").join("llama_server.exe"),
            server_dir.join("llama_server.exe"),
            server_dir.join("llama_server").join("llama_server").join("llama_server.exe"),
        ]
    } else if cfg!(target_os = "macos") {
        vec![
            server_dir.join("mlx_server").join("mlx_server"),
        ]
    } else {
        vec![
            server_dir.join("llama_server").join("llama_server"),
            server_dir.join("llama_server"),
            server_dir.join("llama_server").join("llama_server").join("llama_server"),
        ]
    };
    
    let server_exe = possible_paths.iter().find(|path| path.exists()).cloned();
    
    eprintln!("Checking for server executable in possible paths:");
    for (i, path) in possible_paths.iter().enumerate() {
        eprintln!("  {}: {} (exists: {})", i, path.to_string_lossy(), path.exists());
    }
    eprintln!("Server directory exists: {}", server_dir.exists());
    if server_dir.exists() {
        eprintln!("Contents of server directory:");
        if let Ok(entries) = fs::read_dir(&server_dir) {
            for entry in entries.flatten() {
                eprintln!("  - {}", entry.path().to_string_lossy());
            }
        }
    }

    let server_exe = match server_exe {
        Some(path) => path,
        None => {
            return Ok(ManagedLLMServerInfo {
                status: "not_downloaded".to_string(),
                version: None,
                path: None,
                port: None,
                error: None,
            });
        }
    };

    // Try to read stored version, fallback to hardcoded "1.0.0" if not found
    let stored_version = read_downloaded_version(&app_data_dir)
        .or_else(|| Some("1.0.0".to_string()));

    // Get the host and port from the stored config, or use defaults
    let (host, port) = {
        let state_guard = state.lock().unwrap();
        if let Some((_, process_info)) = state_guard.as_ref() {
            (process_info.config.host.clone(), process_info.config.port)
        } else {
            ("127.0.0.1".to_string(), 8000)
        }
    };

    // Check if process is running by trying to connect
    let client = reqwest::Client::new();
    let test_url = format!("http://{}:{}/v1/models", host, port);
    
    eprintln!("Testing server health at: {}", test_url);
    match client.get(&test_url).timeout(std::time::Duration::from_secs(5)).send().await {
        Ok(response) => {
            eprintln!("Server responded with status: {}", response.status());
            let status_code = response.status();
            // Read the response body to properly close the connection
            let _ = response.bytes().await;
            
            if status_code.is_success() {
                Ok(ManagedLLMServerInfo {
                    status: "running".to_string(),
                    version: stored_version.clone(),
                    path: Some(server_exe.to_string_lossy().to_string()),
                    port: Some(port),
                    error: None,
                })
            } else {
                eprintln!("Server responded but with error status: {}", status_code);
                Ok(ManagedLLMServerInfo {
                    status: "downloaded".to_string(),
                    version: stored_version.clone(),
                    path: Some(server_exe.to_string_lossy().to_string()),
                    port: Some(port),
                    error: Some(format!("Server responded with status: {}", status_code)),
                })
            }
        }
        Err(e) => {
            eprintln!("Failed to connect to server: {}", e);
            Ok(ManagedLLMServerInfo {
                status: "downloaded".to_string(),
                version: stored_version.clone(),
                path: Some(server_exe.to_string_lossy().to_string()),
                port: Some(port),
                error: Some(format!("Connection failed: {}", e)),
            })
        }
    }
}

// Helper function to check if Vulkan runtime is available on Windows
#[cfg(target_os = "windows")]
fn is_vulkan_available() -> bool {
    use std::path::PathBuf;
    
    // Check for vulkan-1.dll in System32
    let system32 = std::env::var("SystemRoot")
        .map(|root| PathBuf::from(root).join("System32"))
        .unwrap_or_else(|_| PathBuf::from("C:\\Windows\\System32"));
    
    let vulkan_dll = system32.join("vulkan-1.dll");
    
    if vulkan_dll.exists() {
        eprintln!("Vulkan runtime detected at: {}", vulkan_dll.display());
        return true;
    }
    
    eprintln!("Vulkan runtime not found in System32");
    false
}

#[cfg(target_os = "linux")]
fn is_vulkan_available() -> bool {
    use std::process::Command;

    let output = match Command::new("vulkaninfo").output() {
        Ok(output) => output,
        Err(e) => {
            eprintln!("Failed to run vulkaninfo: {}", e);
            return false;
        }
    };
    if output.status.success() {
        eprintln!("Vulkan runtime detected");
        return true;
    }
    eprintln!("Vulkan runtime not found");
    return false;
}

// Stub function for macOS - Vulkan is not used on macOS, but this function
// needs to exist for the type checker even though it will never be called
#[cfg(target_os = "macos")]
fn is_vulkan_available() -> bool {
    false
}


#[command]
async fn download_llm_server(app: AppHandle, version: String) -> Result<String, String> {
    let app_data_dir = app.path_resolver()
        .app_data_dir()
        .ok_or("Could not get app data directory")?;
    
    let server_dir = app_data_dir.join("llm-server");
    fs::create_dir_all(&server_dir).map_err(|e| format!("Failed to create server directory: {}", e))?;

    // Determine platform and download URL
    let (filename, extract_dir) = if cfg!(target_os = "windows") {
        // Check if Vulkan is available for Windows
        if is_vulkan_available() {
            eprintln!("Using Vulkan-enabled server");
            ("llama_server-windows-vulkan.zip", "llama_server")
        } else {
            eprintln!("Using CPU-only server (Vulkan not available)");
            ("llama_server-windows-cpu.zip", "llama_server")
        }
    } else if cfg!(target_os = "macos") {
        ("mlx_server-macos.zip", "mlx_server")
    } else {
        if is_vulkan_available() {
            eprintln!("Using Vulkan-enabled server");
            ("llama_server-linux-vulkan.tar.gz", "llama_server")
        } else {
            eprintln!("Using CPU-only server (Vulkan not available)");
            ("llama_server-linux-cpu.tar.gz", "llama_server")
        }
    };

    let download_url = format!(
        "https://github.com/BorisBesky/file-organizer-desktop/releases/download/llm-v{}/{}",
        version, filename
    );
    eprintln!("Download URL: {}", download_url);
    eprintln!("Version: {}", version);
    eprintln!("Filename: {}", filename);
    eprintln!("Extract dir: {}", extract_dir);
    eprintln!("Server dir: {}", server_dir.to_string_lossy());

    let archive_path = server_dir.join(filename);
    
    // Download the file
    let client = reqwest::Client::new();
    let response = client.get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download server: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }

    let mut file = fs::File::create(&archive_path)
        .map_err(|e| format!("Failed to create archive file: {}", e))?;
    
    let content = response.bytes().await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    
    std::io::copy(&mut content.as_ref(), &mut file)
        .map_err(|e| format!("Failed to write archive: {}", e))?;

    // Extract the archive
    let extract_path = server_dir.join(extract_dir);
    if extract_path.exists() {
        fs::remove_dir_all(&extract_path)
            .map_err(|e| format!("Failed to remove existing server: {}", e))?;
    }

    if filename.ends_with(".zip") {
        #[cfg(unix)]
        {
            // Use system unzip on Unix (macOS/Linux) - properly preserves symlinks and permissions
            use std::process::Command;
            
            let output = Command::new("unzip")
                .args(&["-o", archive_path.to_str().unwrap(), "-d", server_dir.to_str().unwrap()])
                .output()
                .map_err(|e| format!("Failed to run unzip: {}", e))?;
            
            if !output.status.success() {
                return Err(format!(
                    "Failed to extract ZIP: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            
            eprintln!("Extracted ZIP using system unzip");
        }
        
        #[cfg(not(unix))]
        {
            // Extract ZIP file using Rust library on Windows
            let file = fs::File::open(&archive_path)
                .map_err(|e| format!("Failed to open ZIP file: {}", e))?;
            let mut archive = ZipArchive::new(file)
                .map_err(|e| format!("Failed to read ZIP archive: {}", e))?;

            for i in 0..archive.len() {
                let mut file = archive.by_index(i)
                    .map_err(|e| format!("Failed to read file from ZIP: {}", e))?;
                let outpath = extract_path.join(file.name());
                
                if file.name().ends_with('/') {
                    fs::create_dir_all(&outpath)
                        .map_err(|e| format!("Failed to create directory: {}", e))?;
                } else {
                    if let Some(p) = outpath.parent() {
                        fs::create_dir_all(p)
                            .map_err(|e| format!("Failed to create parent directory: {}", e))?;
                    }
                    let mut outfile = fs::File::create(&outpath)
                        .map_err(|e| format!("Failed to create file: {}", e))?;
                    std::io::copy(&mut file, &mut outfile)
                        .map_err(|e| format!("Failed to extract file: {}", e))?;
                }
            }
        }
    } else if filename.ends_with(".tar.gz") {
        // Extract TAR.GZ file (Linux/macOS)
        let file = fs::File::open(&archive_path)
            .map_err(|e| format!("Failed to open TAR.GZ file: {}", e))?;
        let gz = GzDecoder::new(file);
        let mut archive = Archive::new(gz);
        
        archive.unpack(&server_dir)
            .map_err(|e| format!("Failed to extract TAR.GZ: {}", e))?;
    }

    // Clean up archive file
    fs::remove_file(&archive_path)
        .map_err(|e| format!("Failed to remove archive: {}", e))?;

    eprintln!("Extraction completed. Checking extracted files:");
    if extract_path.exists() {
        eprintln!("Extract path exists: {}", extract_path.to_string_lossy());
        if let Ok(entries) = fs::read_dir(&extract_path) {
            for entry in entries.flatten() {
                eprintln!("  - {}", entry.path().to_string_lossy());
            }
        }
    } else {
        eprintln!("Extract path does not exist: {}", extract_path.to_string_lossy());
    }

    // Make executable on Unix systems
    #[cfg(unix)]
    {
        let server_exe = if cfg!(target_os = "macos") {
            extract_path.join("mlx_server")
        } else {
            extract_path.join("llama_server")
        };
        
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&server_exe)
            .map_err(|e| format!("Failed to get file metadata: {}", e))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&server_exe, perms)
            .map_err(|e| format!("Failed to set executable permissions: {}", e))?;
    }

    // Store the downloaded version
    if let Err(e) = store_downloaded_version(&app_data_dir, &version) {
        eprintln!("Warning: Failed to store version metadata: {}", e);
    }

    Ok(extract_path.to_string_lossy().to_string())
}

#[command]
async fn update_llm_server(
    app: AppHandle,
    version: String,
    config: ManagedLLMConfig,
    state: State<'_, ManagedLLMState>
) -> Result<String, String> {
    eprintln!("Starting LLM server update to version: {}", version);
    
    let app_data_dir = app.path_resolver()
        .app_data_dir()
        .ok_or("Could not get app data directory")?;
    
    let server_dir = app_data_dir.join("llm-server");
    
    // Determine the server directory based on platform
    let extract_dir = if cfg!(target_os = "windows") {
        "llama_server"
    } else if cfg!(target_os = "macos") {
        "mlx_server"
    } else {
        "llama_server"
    };
    
    let server_path = server_dir.join(extract_dir);
    let backup_path = server_dir.join(format!("{}_backup", extract_dir));
    
    // Step 1: Stop the server if running
    eprintln!("Stopping server...");
    let was_running = {
        let server_state = state.lock().unwrap();
        server_state.is_some()
    };
    
    if was_running {
        if let Err(e) = stop_llm_server(app.clone(), state.clone()).await {
            eprintln!("Warning: Failed to stop server: {}", e);
            // Continue anyway
        }
        // Wait for server to fully stop
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
    
    // Step 2: Backup existing server directory
    if server_path.exists() {
        eprintln!("Backing up existing server...");
        
        // Remove old backup if it exists
        if backup_path.exists() {
            fs::remove_dir_all(&backup_path)
                .map_err(|e| format!("Failed to remove old backup: {}", e))?;
        }
        
        // Create backup
        fs::rename(&server_path, &backup_path)
            .map_err(|e| format!("Failed to create backup: {}", e))?;
        
        eprintln!("Backup created at: {}", backup_path.to_string_lossy());
    } else {
        eprintln!("No existing server found, performing fresh installation");
    }
    
    // Step 3: Download and extract new version
    eprintln!("Downloading new server version...");
    let download_result = download_llm_server(app.clone(), version.clone()).await;
    
    match download_result {
        Ok(_) => {
            eprintln!("Download successful, verifying installation...");
            
            // Step 4: Try to start the server with new version
            if was_running {
                eprintln!("Attempting to start updated server...");
                let start_result = start_llm_server(app.clone(), config.clone(), state.clone()).await;
                
                match start_result {
                    Ok(_) => {
                        // Step 5a: Success - remove backup
                        eprintln!("Server started successfully, removing backup...");
                        if backup_path.exists() {
                            if let Err(e) = fs::remove_dir_all(&backup_path) {
                                eprintln!("Warning: Failed to remove backup: {}", e);
                                // Not a critical error, update was successful
                            }
                        }
                        Ok(format!("Successfully updated to version {}", version))
                    }
                    Err(e) => {
                        // Step 5b: Failed to start - restore backup
                        eprintln!("Failed to start new server: {}, restoring backup...", e);
                        
                        // Remove the failed new installation
                        if server_path.exists() {
                            if let Err(remove_err) = fs::remove_dir_all(&server_path) {
                                eprintln!("Warning: Failed to remove failed installation: {}", remove_err);
                            }
                        }
                        
                        // Restore from backup
                        if backup_path.exists() {
                            fs::rename(&backup_path, &server_path)
                                .map_err(|e| format!("Failed to restore backup: {}", e))?;
                            
                            eprintln!("Backup restored, attempting to start old server...");
                            // Try to restart the old server
                            if let Err(restart_err) = start_llm_server(app, config, state).await {
                                eprintln!("Warning: Failed to restart old server: {}", restart_err);
                            }
                        }
                        
                        Err(format!("Update failed: {}. Restored previous version.", e))
                    }
                }
            } else {
                // Server wasn't running, just remove backup
                eprintln!("Update completed (server was not running)");
                if backup_path.exists() {
                    if let Err(e) = fs::remove_dir_all(&backup_path) {
                        eprintln!("Warning: Failed to remove backup: {}", e);
                    }
                }
                Ok(format!("Successfully updated to version {}", version))
            }
        }
        Err(e) => {
            // Step 5c: Download failed - restore backup
            eprintln!("Download failed: {}, restoring backup...", e);
            
            if backup_path.exists() {
                // Remove any partial download
                if server_path.exists() {
                    if let Err(remove_err) = fs::remove_dir_all(&server_path) {
                        eprintln!("Warning: Failed to remove partial download: {}", remove_err);
                    }
                }
                
                // Restore backup
                fs::rename(&backup_path, &server_path)
                    .map_err(|e| format!("Failed to restore backup: {}", e))?;
                
                eprintln!("Backup restored");
                
                // Try to restart the old server if it was running
                if was_running {
                    if let Err(restart_err) = start_llm_server(app, config, state).await {
                        eprintln!("Warning: Failed to restart old server: {}", restart_err);
                    }
                }
            }
            
            Err(format!("Update failed: {}. Previous version restored.", e))
        }
    }
}

#[command]
async fn start_llm_server(
    app: AppHandle,
    config: ManagedLLMConfig,
    state: State<'_, ManagedLLMState>
) -> Result<String, String> {
    eprintln!("Received config for starting server: {:?}", config);
    
    // Stop any existing server first
    let _ = stop_llm_server(app.clone(), state.clone()).await;

    let app_data_dir = app.path_resolver()
        .app_data_dir()
        .ok_or("Could not get app data directory")?;
    
    let server_dir = app_data_dir.join("llm-server");
    let server_exe = if cfg!(target_os = "windows") {
        server_dir.join("llama_server").join("llama_server").join("llama_server.exe")
    } else if cfg!(target_os = "macos") {
        server_dir.join("mlx_server").join("mlx_server")
    } else {
        server_dir.join("llama_server").join("llama_server")
    };

    if !server_exe.exists() {
        return Err("Server binary not found. Please download it first.".to_string());
    }

    let mut cmd = Command::new(&server_exe);
    
    // Add command-line arguments (preferred method)
    cmd.arg("--host").arg(&config.host);
    cmd.arg("--port").arg(config.port.to_string());
    cmd.arg("--log-level").arg(&config.log_level);
    
    // Add model arguments if specified
    if let Some(model) = &config.model {
        cmd.arg("--model").arg(model);
    }
    if let Some(model_filename) = &config.model_filename {
        cmd.arg("--filename").arg(model_filename);
    }
    if let Some(model_path) = &config.model_path {
        cmd.arg("--model-path").arg(model_path);
    }
    
    // Add multi-modal arguments if specified
    if let Some(mmproj_repo_id) = &config.mmproj_repo_id {
        cmd.arg("--mmproj-repo-id").arg(mmproj_repo_id);
    }
    if let Some(mmproj_filename) = &config.mmproj_filename {
        cmd.arg("--mmproj-filename").arg(mmproj_filename);
    }
    if let Some(chat_format) = &config.chat_format {
        cmd.arg("--chat-format").arg(chat_format);
    }

    // Configure process creation for proper cleanup on Windows
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_PROCESS_GROUP (0x00000200) - allows us to kill the process tree
        // CREATE_NO_WINDOW (0x08000000) - prevents console window from appearing
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    // Start the server process
    eprintln!("Starting server with command: {:?}", server_exe);
    eprintln!("Command-line arguments: --host {} --port {} --log-level {}", 
              config.host, config.port, config.log_level);
    
    cmd.stdout(Stdio::null()).stderr(Stdio::inherit()); // Show stderr in terminal

    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to start server: {}", e))?;

    eprintln!("Server process started with PID: {:?}", child.id());

    // Wait a moment to see if the process crashes immediately
    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    
    // Check if the process is still running
    match child.try_wait() {
        Ok(Some(status)) => {
            return Err(format!("Server process exited immediately with status: {}", status));
        }
        Ok(None) => {
            eprintln!("Server process still running after 1 second");
        }
        Err(e) => {
            return Err(format!("Error checking server status: {}", e));
        }
    }

    // Store the process handle and config
    let pid = child.id();
    
    // Write PID file for orphan detection
    write_pid_file(&app_data_dir, pid, &config)?;
    
    // Create process info
    let process_info = ServerProcessInfo {
        pid,
        config: config.clone(),
    };
    
    {
        let mut state_guard = state.lock().unwrap();
        *state_guard = Some((Some(child), process_info));
        eprintln!("Stored server process with PID {} in state", pid);
    }

    eprintln!("Server process stored, waiting for initialization...");
    
    // Give the server more time to start up
    tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
    
    // Test if the server is responding
    let test_url = format!("http://{}:{}/v1/models", config.host, config.port);
    eprintln!("Testing server startup at: {}", test_url);
    
    let client = reqwest::Client::new();
    match client.get(&test_url).timeout(std::time::Duration::from_secs(10)).send().await {
        Ok(response) => {
            eprintln!("Server startup test successful: {}", response.status());
            // Read the response body to properly close the connection
            let _ = response.bytes().await;
        }
        Err(e) => {
            eprintln!("Server startup test failed: {}", e);
        }
    }

    Ok(format!("Server started on {}:{}", config.host, config.port))
}

#[command]
async fn stop_llm_server(app: AppHandle, state: State<'_, ManagedLLMState>) -> Result<String, String> {
    eprintln!("Attempting to stop LLM server...");
    
    let app_data_dir = app.path_resolver()
        .app_data_dir()
        .ok_or("Could not get app data directory")?;
    
    let mut state_guard = state.lock().unwrap();
    eprintln!("Got lock on state");
    
    let has_process = state_guard.is_some();
    eprintln!("State has process: {}", has_process);
    
    if let Some((child_opt, process_info)) = state_guard.take() {
        let pid = process_info.pid;
        eprintln!("Found server process with PID: {}", pid);
        
        // On Windows, use taskkill to forcefully terminate the process tree first
        #[cfg(target_os = "windows")]
        {
            eprintln!("Using taskkill to terminate process tree for PID: {}", pid);
            let output = std::process::Command::new("taskkill")
                .args(&["/F", "/T", "/PID", &pid.to_string()])
                .output();
            
            match output {
                Ok(output) => {
                    if output.status.success() {
                        eprintln!("Successfully killed process tree with taskkill");
                    } else {
                        eprintln!("Taskkill failed: {}", String::from_utf8_lossy(&output.stderr));
                    }
                }
                Err(e) => {
                    eprintln!("Failed to execute taskkill: {}", e);
                }
            }
            
            // Give the process a moment to terminate
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        
        // Also try to kill via Child handle (if we have it)
        if let Some(mut child) = child_opt {
            eprintln!("Also killing via Child handle");
            let _ = child.kill();
            let _ = child.wait();
        }
        
        // On Unix systems, kill by PID
        #[cfg(unix)]
        {
            let _ = kill_process_by_pid(pid);
        }
        
        // Verify the process is actually dead
        if is_process_running(pid) {
            eprintln!("Warning: Process {} may still be running after kill attempt", pid);
        } else {
            eprintln!("Confirmed: Process {} has terminated", pid);
        }
        
        // Clean up PID file
        remove_pid_file(&app_data_dir);
        
        Ok("Server stopped".to_string())
    } else {
        eprintln!("No server process found in state");
        Ok("Server was not running".to_string())
    }
}

#[command]
async fn get_llm_server_info(app: AppHandle, state: State<'_, ManagedLLMState>) -> Result<ManagedLLMServerInfo, String> {
    get_llm_server_status(app, state).await
}

// Helper function to parse semantic version string (e.g., "1.2.3")
fn parse_version(version_str: &str) -> Option<(u32, u32, u32)> {
    let cleaned = version_str.trim().trim_start_matches('v');
    let parts: Vec<&str> = cleaned.split('.').collect();
    if parts.len() >= 3 {
        let major = parts[0].parse::<u32>().ok()?;
        let minor = parts[1].parse::<u32>().ok()?;
        let patch = parts[2].parse::<u32>().ok()?;
        Some((major, minor, patch))
    } else {
        None
    }
}

// Compare two semantic versions
// Returns: Some(true) if version1 > version2, Some(false) if version1 <= version2, None if invalid
fn compare_versions(version1: &str, version2: &str) -> Option<bool> {
    let v1 = parse_version(version1)?;
    let v2 = parse_version(version2)?;
    
    if v1.0 > v2.0 {
        Some(true)
    } else if v1.0 < v2.0 {
        Some(false)
    } else if v1.1 > v2.1 {
        Some(true)
    } else if v1.1 < v2.1 {
        Some(false)
    } else if v1.2 > v2.2 {
        Some(true)
    } else {
        Some(false) // Equal versions
    }
}

// Fetch latest llm-server version from GitHub releases
async fn check_llm_server_latest_version() -> Result<Option<String>, String> {
    let client = reqwest::Client::new();
    let url = "https://api.github.com/repos/BorisBesky/file-organizer-desktop/releases";
    
    let response = client
        .get(url)
        .header("User-Agent", "file-organizer-desktop")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch releases: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }
    
    let releases: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse releases JSON: {}", e))?;
    
    // Find the latest release with tag starting with "llm-v"
    for release in releases {
        if let Some(tag_name) = release["tag_name"].as_str() {
            if tag_name.starts_with("llm-v") {
                // Extract version from tag (e.g., "llm-v1.0.0" -> "1.0.0")
                let version = tag_name.strip_prefix("llm-v").unwrap_or(tag_name);
                return Ok(Some(version.to_string()));
            }
        }
    }
    
    Ok(None)
}

// Response type for update check
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LLMServerUpdateInfo {
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub current_version: Option<String>,
}

#[command]
async fn check_llm_server_update(
    app: AppHandle,
    state: State<'_, ManagedLLMState>
) -> Result<LLMServerUpdateInfo, String> {
    // Get current installed version
    let status = get_llm_server_status(app, state).await?;
    let current_version = status.version.clone();
    
    // Fetch latest version from GitHub
    let latest_version = match check_llm_server_latest_version().await {
        Ok(Some(version)) => Some(version),
        Ok(None) => {
            eprintln!("No llm-v* releases found on GitHub");
            None
        }
        Err(e) => {
            eprintln!("Failed to check for updates: {}", e);
            None
        }
    };
    
    // Determine if update is available
    let update_available = match (&current_version, &latest_version) {
        (Some(current), Some(latest)) => {
            match compare_versions(latest, current) {
                Some(true) => true, // latest > current
                _ => false,
            }
        }
        (None, Some(_)) => true, // No current version but latest exists
        _ => false, // No latest version or both None
    };
    
    Ok(LLMServerUpdateInfo {
        latest_version,
        update_available,
        current_version,
    })
}

// Helper function to get version metadata file path
fn get_version_metadata_path(app_data_dir: &std::path::PathBuf) -> std::path::PathBuf {
    app_data_dir.join("llm-server").join("version.json")
}

// Store version after download
fn store_downloaded_version(app_data_dir: &std::path::PathBuf, version: &str) -> Result<(), String> {
    let version_file = get_version_metadata_path(app_data_dir);
    let version_data = serde_json::json!({
        "version": version,
        "downloaded_at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    });
    
    fs::write(&version_file, version_data.to_string())
        .map_err(|e| format!("Failed to write version file: {}", e))?;
    
    Ok(())
}

// Read stored version
fn read_downloaded_version(app_data_dir: &std::path::PathBuf) -> Option<String> {
    let version_file = get_version_metadata_path(app_data_dir);
    if !version_file.exists() {
        return None;
    }
    
    let version_data = fs::read_to_string(&version_file).ok()?;
    let version_json: serde_json::Value = serde_json::from_str(&version_data).ok()?;
    version_json["version"].as_str().map(|s| s.to_string())
}

fn create_menu() -> Menu {
    let help_menu = Menu::new()
        .add_item(CustomMenuItem::new("show_help".to_string(), "File Organizer Help"))
        .add_native_item(MenuItem::Separator)
        .add_item(CustomMenuItem::new("about".to_string(), "About File Organizer"));

    #[cfg(target_os = "macos")]
    {
        Menu::new()
            .add_submenu(Submenu::new(
                "File Organizer",
                Menu::new()
                    .add_item(CustomMenuItem::new("about".to_string(), "About File Organizer"))
                    .add_native_item(MenuItem::Separator)
                    .add_native_item(MenuItem::Hide)
                    .add_native_item(MenuItem::HideOthers)
                    .add_native_item(MenuItem::ShowAll)
                    .add_native_item(MenuItem::Separator)
                    .add_native_item(MenuItem::Quit),
            ))
            .add_submenu(Submenu::new("File", Menu::new()))
            .add_submenu(Submenu::new("Edit", Menu::new()
                .add_native_item(MenuItem::Undo)
                .add_native_item(MenuItem::Redo)
                .add_native_item(MenuItem::Separator)
                .add_native_item(MenuItem::Cut)
                .add_native_item(MenuItem::Copy)
                .add_native_item(MenuItem::Paste)
                .add_native_item(MenuItem::SelectAll)
            ))
            .add_submenu(Submenu::new("Help", help_menu))
    }

    #[cfg(not(target_os = "macos"))]
    {
        Menu::new()
            .add_submenu(Submenu::new("File", Menu::new()
                .add_native_item(MenuItem::Quit)
            ))
            .add_submenu(Submenu::new("Edit", Menu::new()
                .add_native_item(MenuItem::Undo)
                .add_native_item(MenuItem::Redo)
                .add_native_item(MenuItem::Separator)
                .add_native_item(MenuItem::Cut)
                .add_native_item(MenuItem::Copy)
                .add_native_item(MenuItem::Paste)
                .add_native_item(MenuItem::SelectAll)
            ))
            .add_submenu(Submenu::new("Help", help_menu))
    }
}

fn handle_menu_event(event: WindowMenuEvent) {
    match event.menu_item_id() {
        "show_help" => {
            let _ = event.window().emit("show-help", ());
        }
        "about" => {
            let _ = event.window().emit("show-about", ());
        }
        _ => {}
    }
}

fn main() {
    let menu = create_menu();
    
    // Create the managed state for the LLM server
    let llm_state = Arc::new(Mutex::new(None::<(Option<Child>, ServerProcessInfo)>)) as ManagedLLMState;
    
    // Clone for the setup closure
    let llm_state_setup = llm_state.clone();
    // Clone for the window event closure
    let llm_state_window = llm_state.clone();
    
    tauri::Builder::default()
        .menu(menu)
        .on_menu_event(handle_menu_event)
        .manage(llm_state)
        .setup(move |app| {
            // Try to reconnect to orphaned server on startup
            let app_handle = app.handle();
            let state = llm_state_setup.clone();
            
            tauri::async_runtime::spawn(async move {
                if let Some(app_data_dir) = app_handle.path_resolver().app_data_dir() {
                    eprintln!("Checking for orphaned LLM server processes...");
                    if let Err(e) = try_reconnect_orphaned_server(&app_data_dir, &state).await {
                        eprintln!("Failed to reconnect to orphaned server: {}", e);
                    }
                }
            });
            
            Ok(())
        })
        .on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event.event() {
                eprintln!("Window closing, shutting down LLM server if running...");
                
                // Get app data dir for PID file cleanup
                let app_data_dir = event.window().app_handle().path_resolver().app_data_dir();
                
                // Stop the LLM server
                let mut state_guard = llm_state_window.lock().unwrap();
                if let Some((child_opt, process_info)) = state_guard.take() {
                    let pid = process_info.pid;
                    eprintln!("Stopping LLM server with PID: {}", pid);
                    
                    // On Windows, use taskkill first for forceful termination
                    #[cfg(target_os = "windows")]
                    {
                        let _ = kill_process_by_pid(pid);
                        // Brief wait to ensure termination
                        std::thread::sleep(std::time::Duration::from_millis(300));
                    }
                    
                    // Also kill via Child handle if available
                    if let Some(mut child) = child_opt {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    
                    // On Unix, kill by PID
                    #[cfg(unix)]
                    {
                        let _ = kill_process_by_pid(pid);
                    }
                    
                    // Clean up PID file
                    if let Some(app_data_dir) = app_data_dir {
                        remove_pid_file(&app_data_dir);
                    }
                    
                    eprintln!("LLM server stopped on app exit");
                } else {
                    eprintln!("No LLM server was running on exit");
                }
                
                // Final safety measure: kill any remaining llama_server.exe processes by name
                #[cfg(target_os = "windows")]
                {
                    eprintln!("Final cleanup: killing any remaining llama_server.exe processes");
                    let _ = kill_process_by_name("llama_server.exe");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_directory,
            list_subdirectories,
            pick_directory,
            read_file_content,
            move_file,
            http_request,
            save_diagnostic_logs,
            open_file,
            get_app_version,
            get_llm_server_status,
            download_llm_server,
            update_llm_server,
            start_llm_server,
            stop_llm_server,
            get_llm_server_info,
            check_llm_server_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}