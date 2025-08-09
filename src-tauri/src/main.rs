#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use std::fs;
use std::path::Path;
use tauri::api::dialog::FileDialogBuilder;
use tauri::{command, AppHandle, Manager};

#[command]
async fn read_directory(path: String) -> Result<Vec<String>, String> {
    fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .map(|res| res.map(|e| e.path().to_string_lossy().into_owned()))
        .collect::<Result<Vec<String>, std::io::Error>>()
        .map_err(|e| e.to_string())
}

#[command]
async fn read_file_content(path: String) -> Result<String, String> {
    if path.ends_with(".pdf") {
        // Use a more robust approach for PDF extraction with error handling
        match std::panic::catch_unwind(|| pdf_extract::extract_text(&path)) {
            Ok(Ok(text)) => Ok(text),
            Ok(Err(e)) => {
                // If PDF extraction fails, return a descriptive error instead of panicking
                Err(format!("Failed to extract text from PDF: {}. This PDF may have complex fonts or encoding issues.", e))
            }
            Err(_) => {
                // If the library panics, catch it and return a user-friendly error
                Err("Failed to extract text from PDF: The PDF contains unsupported fonts or encoding that cannot be processed.".to_string())
            }
        }
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            read_directory,
            pick_directory,
            read_file_content,
            move_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}