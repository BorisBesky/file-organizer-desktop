#[cfg(target_os = "windows")]
use rfd::FileDialog;
use std::path::PathBuf;

#[cfg(target_os = "windows")]
#[test]
#[ignore] // This test requires user interaction - run with: cargo test -- --ignored
fn folder_picker_returns_paths() {
    println!("Opening native dialog to select multiple directories...");

    // Open the dialog
    let folders: Option<Vec<PathBuf>> = FileDialog::new()
        .set_title("Select one or more directories")
        // You can optionally set a starting directory
        // .set_directory("/") 
        .pick_folders();

    // Handle the result
    match folders {
        Some(paths) => {
            if paths.is_empty() {
                // This case might happen if the dialog logic allows "OK" with no selection
                println!("No directories were selected.");
            } else {
                println!("You selected the following directories:");
                // Iterate over the vector of PathBufs
                for path in paths {
                    println!("- {}", path.display());
                }
            }
        }
        None => {
            // This happens if the user presses "Cancel" or closes the dialog
            println!("Dialog was canceled. No directories selected.");
        }
    }
}

#[cfg(not(target_os = "windows"))]
#[test]
fn folder_picker_returns_paths() {
    eprintln!("Skipping FolderPicker test on non-Windows platform.");
}
