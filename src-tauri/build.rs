fn main() {
  // Set build timestamp as an environment variable for compile time
  println!(
    "cargo:rustc-env=BUILD_TIMESTAMP={}",
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC")
  );
  
  tauri_build::build()
}
