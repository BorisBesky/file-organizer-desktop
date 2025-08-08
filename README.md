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

- Use the application to select a directory and organize files based on AI classification.
- Review and edit proposed file names and categories before applying changes.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request for any improvements or bug fixes.

## License

This project is licensed under the MIT License. See the LICENSE file for more details.