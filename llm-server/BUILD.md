# Building LLM Servers

This document describes how to build the LLM servers locally and via GitHub Actions.

## GitHub Actions (Automated Build)

The project includes a GitHub Actions workflow that automatically builds all LLM servers.

### Trigger Methods

#### 1. Tag-based Release (Recommended)
Push a tag starting with `llm-v`:
```bash
git tag llm-v1.0.0
git push origin llm-v1.0.0
```

This will:
- Build all three servers (Windows Llama, Linux Llama, macOS MLX)
- Create a GitHub Release with all artifacts attached
- Use the version from `version.py` files

#### 2. Manual Trigger
1. Go to **Actions** tab in GitHub
2. Select **Build LLM Servers** workflow
3. Click **Run workflow**
4. Enter version number (e.g., `1.0.0`)
5. Click **Run workflow**

This will:
- Build all three servers
- Update `version.py` with the provided version
- Upload artifacts (but won't create a release)

### Artifacts

After the workflow completes, you can download:
- `llama_server-windows.zip` - Windows Llama server
- `llama_server-linux.tar.gz` - Linux Llama server  
- `mlx_server-macos.tar.gz` - macOS MLX server

## Local Build

### Windows Llama Server

```bash
cd llm-server/windows/ollama
pip install pyinstaller llama-cpp-python fastapi uvicorn pydantic huggingface-hub
pyinstaller llama_server.spec
```

Output: `dist/llama_server/`

### Linux Llama Server

```bash
cd llm-server/linux/ollama
pip install pyinstaller llama-cpp-python fastapi uvicorn pydantic huggingface-hub
pyinstaller llama_server.spec
```

Output: `dist/llama_server/`

### macOS MLX Server

```bash
cd llm-server/macos/mlx
pip install pyinstaller mlx mlx-lm transformers tokenizers huggingface-hub
pyinstaller mlx_server.spec
```

Output: `dist/mlx_server/`

## Version Management

### Updating Version

To update the version for a new release, edit the appropriate `version.py` file:

**Windows/Linux Llama**: `llm-server/windows/ollama/version.py`
```python
__version__ = "1.1.0"
__build_date__ = "2025-10-14"
```

**macOS MLX**: `llm-server/macos/mlx/version.py`
```python
__version__ = "1.1.0"
__build_date__ = "2025-10-14"
```

### Checking Version

All servers support the `--version` flag:
```bash
./llama_server --version
# Output: llama_server version 1.0.0 (build date: 2025-10-14)

./mlx_server --version
# Output: mlx_server version 1.0.0 (build date: 2025-10-14)
```

## Server Configuration

All servers support unified command-line arguments and environment variables for configuration.

### Command-Line Arguments

All servers support the following arguments:
- `--host` - Host address to bind to (default: 127.0.0.1)
- `--port`, `-p` - Port to listen on (default: 8000)
- `--log-level` - Logging level: critical, error, warning, info, debug (default: info)
- `--model` - Model to use
- `--model-path` - Path to local model file (skips download)
- `--version`, `-v` - Show version information
- `--help`, `-h` - Show help message

**Llama servers** (Windows/Linux) also support:
- `--model-id` - Hugging Face model ID to download
- `--filename` - Model filename to download from Hugging Face

### Environment Variables

Configuration priority: **command-line args > environment variables > defaults**

**Llama/MLX Servers** (Windows/Linux/macOS):
- `SERVER_HOST` - Host to listen on (default: 127.0.0.1)
- `SERVER_PORT` - Port to listen on (default: 8000)
- `SERVER_LOG_LEVEL` - Log level (default: info)
- `SERVER_MODEL` - Model to use (default: mlx-community/Phi-3.5-mini-instruct-4bit)

**Llama servers** (Windows/Linux):
- `SERVER_FILENAME` - Model filename
- `SERVER_MODEL_PATH` - Path to local model file

### Example Usage

```bash
# Using command-line arguments
./llama_server --host 0.0.0.0 --port 9000 --log-level debug

# Using command-line arguments
./mlx_server --host 0.0.0.0 --port 9000 --log-level debug

# Using environment variables
export SERVER_PORT=9000
export SERVER_LOG_LEVEL=debug
./llama_server

# Using environment variables (macOS)
export SERVER_PORT=9000
export SERVER_LOG_LEVEL=debug
./mlx_server
```

## Platform Notes

### Windows
- Uses `llama-cpp-python` for model inference
- Supports GGUF models from Hugging Face

### Linux
- Shares the same codebase as Windows (via symlinks)
- Uses `llama-cpp-python` for model inference

### macOS
- Uses Apple Silicon-optimized `mlx` framework
- Supports MLX-compatible models
- Leverages Metal for GPU acceleration

