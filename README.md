# File Organizer Desktop

This project is a cross-platform file organizer application built using React and Tauri. It allows users to organize their files efficiently with the help of AI classification.

## Project Structure

```
file-organizer-desktop
├── src
│   ├── App.tsx          # Main React component managing the application state and UI
│   ├── main.tsx         # Entry point for the React application
│   ├── components       # Directory for reusable components
│   │   └── index.ts     # Exports various components for modularity
│   └── types            # Directory for TypeScript types and interfaces
│       └── index.ts     # Type definitions for the application
├── index.html           # Main HTML file for the application
├── package.json         # npm configuration file with dependencies and scripts
├── tsconfig.json        # TypeScript configuration file
├── vite.config.ts       # Vite configuration for development and production builds
├── src-tauri            # Directory for Tauri backend
│   ├── src
│   │   └── main.rs      # Main Rust file for Tauri application
│   ├── Cargo.toml       # Rust project configuration file
│   └── tauri.conf.json   # Tauri application configuration
└── README.md            # Documentation for the project
```

## Setup Instructions

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd file-organizer-desktop
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run the application:**
   ```bash
   npm run dev
   ```

## Usage

### Basic Operation
- Use the application to select a directory and organize files based on AI classification.
- Review and edit proposed file names and categories before applying changes.

### Scan Control Features
The application now supports advanced scan control:

#### **Pause/Resume Scan**
- While scanning is in progress, click the "Pause" button to temporarily halt the process
- The scan state is preserved, showing progress and partial results
- Click "Resume" to continue from where you left off
- Progress bar updates to show paused state

#### **Stop Scan**
- Click "Stop" during scanning or while paused to permanently halt the process
- When stopped, the application will:
  - Display a preview of all files scanned up to that point
  - Automatically send current results to LM Studio for category optimization
  - Allow you to review and approve the partial results
  - Show "Stopped at user request" in the progress indicator

#### **New Scan**
- After completing or stopping a scan, use "New Scan" to start fresh
- This resets all scan state and clears previous results

### LM Studio Integration
- Configure your LM Studio base URL (e.g., `http://localhost:1234/v1`)
- Select your preferred model for file classification
- The app automatically sends partial results to LM Studio for optimization when scans are stopped
- Category optimization suggestions are applied automatically and logged in the status area

### Real-time Feedback
- Status area shows detailed progress of file reading and classification
- Progress bar displays current file count and percentage completed
- Scan state indicators (Scanning, Paused, Stopped, Completed) provide clear status

## Contributing

Contributions are welcome! Please open an issue or submit a pull request for any improvements or bug fixes.

## License

This project is licensed under the MIT License. See the LICENSE file for more details.