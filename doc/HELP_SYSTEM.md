# Native Help System Implementation

## Overview
Added native platform-specific help system to the File Organizer application, integrated with the system menu bar.

## Features

### 1. Platform-Specific Menu Integration
- **macOS**: Help menu appears in the standard macOS menu bar
- **Windows/Linux**: Help menu appears in the application window menu bar
- Menu items:
  - "File Organizer Help" - Opens comprehensive help dialog
  - "About File Organizer" - Opens about dialog

### 2. Help Dialog
Comprehensive help documentation covering:
- 🚀 Quick Start Guide
- ⚙️ Features overview
- 🤖 LLM Provider information (LM Studio, Ollama, OpenAI, Anthropic, Groq, Gemini, Custom)
- 📁 How It Works explanation
- 💡 Tips and best practices
- ⚠️ Important safety notes
- ⌨️ Keyboard shortcuts

### 3. About Dialog
Application information including:
- Application name and version
- Description
- List of supported AI providers
- Technology stack
- Copyright information

## Files Modified/Created

### Backend (Rust)
- **src-tauri/src/main.rs**
  - Added menu creation with platform-specific handling
  - Created `create_menu()` function for macOS and other platforms
  - Added `handle_menu_event()` to emit events for menu actions
  - Integrated menu with Tauri builder

### Frontend (React/TypeScript)
- **src/components/HelpDialog.tsx** (new)
  - Modal dialog component for help content
  - Responsive design with scrollable content
  - Comprehensive documentation sections

- **src/components/AboutDialog.tsx** (new)
  - Modal dialog component for about information
  - Clean, centered layout
  - Feature list and technology stack

- **src/components/index.ts**
  - Exported new HelpDialog and AboutDialog components

- **src/App.tsx**
  - Added state management for help and about dialogs
  - Added event listeners for 'show-help' and 'show-about' events
  - Integrated dialog components into main app

### Styling
- **src/style.css**
  - Added comprehensive modal styles
  - Platform-specific backdrop blur with Safari compatibility
  - Responsive modal sizing and animations
  - Help and About modal specific styles
  - Smooth fade-in animation

## Usage

### Accessing Help
- **macOS**: Menu Bar → Help → File Organizer Help
- **Windows/Linux**: Application Menu → Help → File Organizer Help

### Accessing About
- **macOS**: Menu Bar → File Organizer → About File Organizer
- **Windows/Linux**: Application Menu → Help → About File Organizer

## Technical Details

### Event System
The help system uses Tauri's event system:
1. Rust menu handler emits events (`show-help`, `show-about`)
2. React frontend listens for these events
3. Events trigger state changes to open respective modals

### Modal Implementation
- Overlay with semi-transparent backdrop
- Click outside to close
- Escape key support (native browser behavior)
- Smooth animations
- Scrollable content for long help text
- Responsive sizing

### Platform Compatibility
- macOS: Standard macOS menu structure with app menu
- Windows/Linux: Traditional window menu structure
- All platforms: Consistent keyboard shortcuts (Undo, Redo, Cut, Copy, Paste, SelectAll)

## Future Enhancements
- Add keyboard shortcut for help (e.g., Cmd+? or F1)
- Add context-sensitive help
- Add search functionality within help dialog
- Add links to online documentation
- Add tutorial/walkthrough mode
