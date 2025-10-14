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
- Build all three servers (Windows Ollama, Linux Ollama, macOS MLX)
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
- `ollama_server-windows.zip` - Windows Ollama server
- `ollama_server-linux.tar.gz` - Linux Ollama server  
- `mlx_server-macos.tar.gz` - macOS MLX server

## Local Build

### Windows Ollama Server

```bash
cd llm-server/windows/ollama
pip install pyinstaller llama-cpp-python fastapi uvicorn pydantic huggingface-hub
pyinstaller ollama_server.spec
```

Output: `dist/ollama_server/`

### Linux Ollama Server

```bash
cd llm-server/linux/ollama
pip install pyinstaller llama-cpp-python fastapi uvicorn pydantic huggingface-hub
pyinstaller ollama_server.spec
```

Output: `dist/ollama_server/`

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

**Windows/Linux Ollama**: `llm-server/windows/ollama/version.py`
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
./ollama_server --version
# Output: ollama_server version 1.0.0 (build date: 2025-10-14)

./mlx_server --version
# Output: mlx_server version 1.0.0 (build date: 2025-10-14)
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

