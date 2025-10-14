#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use std::fs;
use std::path::Path;
use std::io::Write;
use std::thread;
use std::panic;
use std::sync::{Mutex, OnceLock};
use tauri::api::dialog::FileDialogBuilder;
use tauri::{command, AppHandle, Manager, CustomMenuItem, Menu, MenuItem, Submenu, WindowMenuEvent};
use walkdir::WalkDir;

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

#[command]
async fn read_file_content(path: String) -> Result<String, String> {
    if path.to_lowercase().ends_with(".pdf") {
        // Run extraction in an isolated thread so panics cannot crash the runtime
        extract_pdf_text(&path)
    } else {
        fs::read_to_string(&path).map_err(|e| e.to_string())
    }
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