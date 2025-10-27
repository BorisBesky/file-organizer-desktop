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
use std::collections::{HashMap, HashSet};
use tauri::api::dialog::FileDialogBuilder;
use tauri::{command, AppHandle, Manager, CustomMenuItem, Menu, MenuItem, Submenu, WindowMenuEvent, State};
use walkdir::WalkDir;
use docx_rs::*;
use calamine::{Reader, open_workbook, Xlsx};
use image::GenericImageView;
use base64::Engine;
use serde::{Deserialize, Serialize};
use zip::ZipArchive;
use flate2::read::GzDecoder;
use tar::Archive;
use sha2::{Sha256, Digest};
use regex::Regex;

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
    pub model_path: Option<String>,
    pub log_level: String,
    pub env_vars: HashMap<String, String>,
}

// Global state for the managed LLM server process and its config
type ManagedLLMState = Arc<Mutex<Option<(Child, ManagedLLMConfig)>>>;

#[command]
async fn read_directory(path: String, include_subdirectories: bool) -> Result<Vec<String>, String> {
    if include_subdirectories {
        let entries = WalkDir::new(path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .map(|e| e.path().to_string_lossy().into_owned())
            .collect::<Vec<String>>();
        Ok(entries)
    } else {
        let entries = fs::read_dir(path)
            .map_err(|e| e.to_string())?
            .filter_map(|res| res.ok())
            .filter(|entry| entry.path().is_file())
            .map(|e| e.path().to_string_lossy().into_owned())
            .collect::<Vec<String>>();
        Ok(entries)
    }
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
fn pick_directory(app: AppHandle) {
    FileDialogBuilder::new().pick_folder(move |folder_path| {
        if let Some(path) = folder_path {
            let path_str = path.to_str().unwrap_or("").to_string();
            app.emit_all("directory-selected", path_str).unwrap();
        }
    });
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

#[command]
async fn get_llm_server_status(app: AppHandle, state: State<'_, ManagedLLMState>) -> Result<ManagedLLMServerInfo, String> {
    let app_data_dir = app.path_resolver()
        .app_data_dir()
        .ok_or("Could not get app data directory")?;
    
    let server_dir = app_data_dir.join("llm-server");
    
    // Try multiple possible locations for the server executable
    let possible_paths = if cfg!(target_os = "windows") {
        vec![
            server_dir.join("ollama_server").join("ollama_server.exe"),
            server_dir.join("ollama_server.exe"),
            server_dir.join("ollama_server").join("ollama_server").join("ollama_server.exe"),
        ]
    } else if cfg!(target_os = "macos") {
        vec![
            server_dir.join("mlx_server").join("mlx_server"),
            server_dir.join("mlx_server"),
            server_dir.join("mlx_server").join("mlx_server").join("mlx_server"),
        ]
    } else {
        vec![
            server_dir.join("ollama_server").join("ollama_server"),
            server_dir.join("ollama_server"),
            server_dir.join("ollama_server").join("ollama_server").join("ollama_server"),
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

    // Get the host and port from the stored config, or use defaults
    let (host, port) = {
        let state_guard = state.lock().unwrap();
        if let Some((_, config)) = state_guard.as_ref() {
            (config.host.clone(), config.port)
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
                    version: Some("1.0.0".to_string()), // TODO: Get actual version
                    path: Some(server_exe.to_string_lossy().to_string()),
                    port: Some(port),
                    error: None,
                })
            } else {
                eprintln!("Server responded but with error status: {}", status_code);
                Ok(ManagedLLMServerInfo {
                    status: "downloaded".to_string(),
                    version: Some("1.0.0".to_string()),
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
                version: Some("1.0.0".to_string()),
                path: Some(server_exe.to_string_lossy().to_string()),
                port: Some(port),
                error: Some(format!("Connection failed: {}", e)),
            })
        }
    }
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
        ("ollama_server-windows.zip", "ollama_server")
    } else if cfg!(target_os = "macos") {
        ("mlx_server-macos.tar.gz", "mlx_server")
    } else {
        ("ollama_server-linux.tar.gz", "ollama_server")
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
        // Extract ZIP file (Windows)
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
    } else {
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
            extract_path.join("ollama_server")
        };
        
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&server_exe)
            .map_err(|e| format!("Failed to get file metadata: {}", e))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&server_exe, perms)
            .map_err(|e| format!("Failed to set executable permissions: {}", e))?;
    }

    Ok(extract_path.to_string_lossy().to_string())
}

#[command]
async fn start_llm_server(
    app: AppHandle,
    config: ManagedLLMConfig,
    state: State<'_, ManagedLLMState>
) -> Result<String, String> {
    eprintln!("Received config for starting server: {:?}", config);
    
    // Stop any existing server first
    let _ = stop_llm_server(state.clone()).await;

    let app_data_dir = app.path_resolver()
        .app_data_dir()
        .ok_or("Could not get app data directory")?;
    
    let server_dir = app_data_dir.join("llm-server");
    let server_exe = if cfg!(target_os = "windows") {
        server_dir.join("ollama_server").join("ollama_server").join("ollama_server.exe")
    } else if cfg!(target_os = "macos") {
        server_dir.join("mlx_server").join("mlx_server")
    } else {
        server_dir.join("ollama_server").join("ollama_server")
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
    if let Some(model_path) = &config.model_path {
        cmd.arg("--model-path").arg(model_path);
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
    {
        let mut state_guard = state.lock().unwrap();
        *state_guard = Some((child, config.clone()));
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
async fn stop_llm_server(state: State<'_, ManagedLLMState>) -> Result<String, String> {
    eprintln!("Attempting to stop LLM server...");
    
    let mut state_guard = state.lock().unwrap();
    eprintln!("Got lock on state");
    
    let has_child = state_guard.is_some();
    eprintln!("State has child process: {}", has_child);
    
    if let Some((mut child, _config)) = state_guard.take() {
        let pid = child.id();
        eprintln!("Found server process with PID: {}", pid);
        
        match child.kill() {
            Ok(_) => {
                eprintln!("Kill signal sent to PID: {}", pid);
                let _ = child.wait(); // Wait for process to actually terminate
                eprintln!("Server process terminated");
                
                // On Windows, also kill the process tree using taskkill
                #[cfg(target_os = "windows")]
                {
                    let _ = std::process::Command::new("taskkill")
                        .args(&["/F", "/T", "/PID", &pid.to_string()])
                        .output();
                    eprintln!("Sent taskkill command to terminate process tree");
                }
                
                Ok("Server stopped".to_string())
            }
            Err(e) => {
                eprintln!("Failed to kill server process: {}", e);
                Err(format!("Failed to stop server: {}", e))
            }
        }
    } else {
        eprintln!("No server process found in state");
        Ok("Server was not running".to_string())
    }
}

#[command]
async fn get_llm_server_info(app: AppHandle, state: State<'_, ManagedLLMState>) -> Result<ManagedLLMServerInfo, String> {
    get_llm_server_status(app, state).await
}

// Types for file analysis results
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateFileGroup {
    pub hash: String,
    pub size: u64,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnusedFileInfo {
    pub path: String,
    pub size: u64,
    pub last_accessed: Option<String>,
    pub last_modified: Option<String>,
    pub days_since_access: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnreferencedFileInfo {
    pub path: String,
    pub size: u64,
    pub extension: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileAnalysisResult {
    pub duplicates: Vec<DuplicateFileGroup>,
    pub unused: Vec<UnusedFileInfo>,
    pub unreferenced: Vec<UnreferencedFileInfo>,
}

// Helper function to calculate SHA256 hash of a file
fn calculate_file_hash(path: &Path) -> Result<String, std::io::Error> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    
    Ok(format!("{:x}", hasher.finalize()))
}

#[command]
async fn find_duplicate_files(path: String, include_subdirectories: bool) -> Result<Vec<DuplicateFileGroup>, String> {
    let mut hash_map: HashMap<String, Vec<String>> = HashMap::new();
    let mut size_map: HashMap<String, u64> = HashMap::new();
    
    // Get all files
    let files = if include_subdirectories {
        WalkDir::new(&path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .map(|e| e.path().to_path_buf())
            .collect::<Vec<_>>()
    } else {
        fs::read_dir(&path)
            .map_err(|e| e.to_string())?
            .filter_map(|res| res.ok())
            .filter(|entry| entry.path().is_file())
            .map(|e| e.path())
            .collect::<Vec<_>>()
    };
    
    // Calculate hashes for all files
    for file_path in files {
        // Skip hidden files
        if let Some(name) = file_path.file_name() {
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
        }
        
        match calculate_file_hash(&file_path) {
            Ok(hash) => {
                let path_str = file_path.to_string_lossy().to_string();
                hash_map.entry(hash.clone()).or_insert_with(Vec::new).push(path_str);
                
                // Store file size
                if let Ok(metadata) = fs::metadata(&file_path) {
                    size_map.insert(hash, metadata.len());
                }
            }
            Err(e) => {
                eprintln!("Failed to hash file {:?}: {}", file_path, e);
            }
        }
    }
    
    // Filter out unique files and create duplicate groups
    let mut duplicates: Vec<DuplicateFileGroup> = hash_map
        .into_iter()
        .filter(|(_, files)| files.len() > 1)
        .map(|(hash, files)| DuplicateFileGroup {
            hash: hash.clone(),
            size: size_map.get(&hash).copied().unwrap_or(0),
            files,
        })
        .collect();
    
    // Sort by size (largest first)
    duplicates.sort_by(|a, b| b.size.cmp(&a.size));
    
    Ok(duplicates)
}

#[command]
async fn find_unused_files(path: String, include_subdirectories: bool, days_threshold: u64) -> Result<Vec<UnusedFileInfo>, String> {
    let mut unused_files: Vec<UnusedFileInfo> = Vec::new();
    let now = std::time::SystemTime::now();
    
    // Get all files
    let files = if include_subdirectories {
        WalkDir::new(&path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .map(|e| e.path().to_path_buf())
            .collect::<Vec<_>>()
    } else {
        fs::read_dir(&path)
            .map_err(|e| e.to_string())?
            .filter_map(|res| res.ok())
            .filter(|entry| entry.path().is_file())
            .map(|e| e.path())
            .collect::<Vec<_>>()
    };
    
    for file_path in files {
        // Skip hidden files
        if let Some(name) = file_path.file_name() {
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
        }
        
        if let Ok(metadata) = fs::metadata(&file_path) {
            let size = metadata.len();
            
            // Try to get last accessed time
            let (last_accessed, days_since_access) = metadata.accessed()
                .ok()
                .and_then(|accessed| {
                    accessed.duration_since(std::time::UNIX_EPOCH).ok().map(|d| {
                        let accessed_str = chrono::DateTime::<chrono::Utc>::from(
                            std::time::UNIX_EPOCH + d
                        ).format("%Y-%m-%d %H:%M:%S").to_string();
                        
                        let days = now.duration_since(accessed)
                            .ok()
                            .map(|d| d.as_secs() / 86400)
                            .unwrap_or(0);
                        
                        (Some(accessed_str), Some(days))
                    })
                })
                .unwrap_or((None, None));
            
            // Try to get last modified time
            let last_modified = metadata.modified()
                .ok()
                .and_then(|modified| {
                    modified.duration_since(std::time::UNIX_EPOCH).ok().map(|d| {
                        chrono::DateTime::<chrono::Utc>::from(
                            std::time::UNIX_EPOCH + d
                        ).format("%Y-%m-%d %H:%M:%S").to_string()
                    })
                });
            
            // Check if file is unused based on threshold
            if let Some(days) = days_since_access {
                if days >= days_threshold {
                    unused_files.push(UnusedFileInfo {
                        path: file_path.to_string_lossy().to_string(),
                        size,
                        last_accessed,
                        last_modified,
                        days_since_access: Some(days),
                    });
                }
            }
        }
    }
    
    // Sort by days since access (oldest first)
    unused_files.sort_by(|a, b| {
        b.days_since_access.unwrap_or(0).cmp(&a.days_since_access.unwrap_or(0))
    });
    
    Ok(unused_files)
}

#[command]
async fn find_unreferenced_files(path: String, include_subdirectories: bool) -> Result<Vec<UnreferencedFileInfo>, String> {
    let mut all_files: Vec<std::path::PathBuf> = Vec::new();
    let mut referenced_files: HashSet<String> = HashSet::new();
    
    // Get all files
    let files = if include_subdirectories {
        WalkDir::new(&path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .map(|e| e.path().to_path_buf())
            .collect::<Vec<_>>()
    } else {
        fs::read_dir(&path)
            .map_err(|e| e.to_string())?
            .filter_map(|res| res.ok())
            .filter(|entry| entry.path().is_file())
            .map(|e| e.path())
            .collect::<Vec<_>>()
    };
    
    all_files.extend(files);
    
    // Build a regex to find file references (flexible pattern)
    // Matches: ./file, ../file, /path/to/file, file.ext, "file", 'file'
    let file_ref_pattern = Regex::new(r#"(?:^|[\s"'`(])(\.{0,2}/?[\w\-./\\]+\.[\w]+)(?:[\s"'`)]|$)"#)
        .map_err(|e| format!("Failed to compile regex: {}", e))?;
    
    // Scan text files for references to other files
    for file_path in &all_files {
        // Skip hidden files
        if let Some(name) = file_path.file_name() {
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
        }
        
        // Only scan text-based files (common code, config, and doc files)
        if let Some(ext) = file_path.extension() {
            let ext_str = ext.to_string_lossy().to_lowercase();
            let text_extensions = vec![
                "rs", "js", "ts", "jsx", "tsx", "py", "java", "c", "cpp", "h", "hpp",
                "cs", "go", "rb", "php", "swift", "kt", "scala", "sh", "bash",
                "html", "css", "scss", "sass", "less", "xml", "json", "yaml", "yml",
                "toml", "ini", "conf", "config", "md", "txt", "rst", "tex",
            ];
            
            if text_extensions.contains(&ext_str.as_str()) {
                // Read file content
                if let Ok(content) = fs::read_to_string(file_path) {
                    // Find all file references in the content
                    for cap in file_ref_pattern.captures_iter(&content) {
                        if let Some(referenced) = cap.get(1) {
                            let ref_str = referenced.as_str().to_string();
                            
                            // Try to resolve the reference relative to the current file's directory
                            if let Some(parent) = file_path.parent() {
                                let resolved = parent.join(&ref_str);
                                if resolved.exists() {
                                    referenced_files.insert(resolved.to_string_lossy().to_string());
                                }
                            }
                            
                            // Also try relative to the base path
                            let resolved = Path::new(&path).join(&ref_str);
                            if resolved.exists() {
                                referenced_files.insert(resolved.to_string_lossy().to_string());
                            }
                            
                            // Try as an absolute path
                            let resolved = Path::new(&ref_str);
                            if resolved.exists() {
                                referenced_files.insert(resolved.to_string_lossy().to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    
    // Find files that are not referenced
    let mut unreferenced: Vec<UnreferencedFileInfo> = Vec::new();
    for file_path in &all_files {
        // Skip hidden files
        if let Some(name) = file_path.file_name() {
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
        }
        
        let path_str = file_path.to_string_lossy().to_string();
        
        // Check if this file is referenced
        if !referenced_files.contains(&path_str) {
            if let Ok(metadata) = fs::metadata(file_path) {
                unreferenced.push(UnreferencedFileInfo {
                    path: path_str,
                    size: metadata.len(),
                    extension: file_path
                        .extension()
                        .map(|e| e.to_string_lossy().to_string())
                        .unwrap_or_default(),
                });
            }
        }
    }
    
    // Sort by size (largest first)
    unreferenced.sort_by(|a, b| b.size.cmp(&a.size));
    
    Ok(unreferenced)
}

#[command]
async fn analyze_directory_files(
    path: String, 
    include_subdirectories: bool,
    unused_days_threshold: u64,
) -> Result<FileAnalysisResult, String> {
    // Run all three analyses
    let duplicates = find_duplicate_files(path.clone(), include_subdirectories).await?;
    let unused = find_unused_files(path.clone(), include_subdirectories, unused_days_threshold).await?;
    let unreferenced = find_unreferenced_files(path, include_subdirectories).await?;
    
    Ok(FileAnalysisResult {
        duplicates,
        unused,
        unreferenced,
    })
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
    let llm_state = Arc::new(Mutex::new(None::<(Child, ManagedLLMConfig)>)) as ManagedLLMState;
    
    tauri::Builder::default()
        .menu(menu)
        .on_menu_event(handle_menu_event)
        .manage(llm_state.clone())
        .on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event.event() {
                eprintln!("Window closing, shutting down LLM server if running...");
                
                // Stop the LLM server
                let mut state_guard = llm_state.lock().unwrap();
                if let Some((mut child, _config)) = state_guard.take() {
                    let pid = child.id();
                    eprintln!("Stopping LLM server with PID: {}", pid);
                    
                    let _ = child.kill();
                    let _ = child.wait();
                    
                    // On Windows, also kill the process tree
                    #[cfg(target_os = "windows")]
                    {
                        let _ = std::process::Command::new("taskkill")
                            .args(&["/F", "/T", "/PID", &pid.to_string()])
                            .output();
                    }
                    
                    eprintln!("LLM server stopped on app exit");
                } else {
                    eprintln!("No LLM server was running on exit");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_directory,
            pick_directory,
            read_file_content,
            move_file,
            http_request,
            save_diagnostic_logs,
            open_file,
            get_llm_server_status,
            download_llm_server,
            start_llm_server,
            stop_llm_server,
            get_llm_server_info,
            find_duplicate_files,
            find_unused_files,
            find_unreferenced_files,
            analyze_directory_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}