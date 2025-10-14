#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use std::fs;
use std::path::Path;
use std::io::{Write, Read};
use std::thread;
use std::panic;
use std::sync::{Mutex, OnceLock};
use tauri::api::dialog::FileDialogBuilder;
use tauri::{command, AppHandle, Manager, CustomMenuItem, Menu, MenuItem, Submenu, WindowMenuEvent};
use walkdir::WalkDir;
use docx_rs::*;
use calamine::{Reader, open_workbook, Xlsx};
use image::GenericImageView;
use base64::Engine;

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
    
    tauri::Builder::default()
        .menu(menu)
        .on_menu_event(handle_menu_event)
        .invoke_handler(tauri::generate_handler![
            read_directory,
            pick_directory,
            read_file_content,
            move_file,
            http_request,
            save_diagnostic_logs,
            open_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}