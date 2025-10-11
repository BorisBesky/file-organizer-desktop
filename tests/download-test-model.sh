#!/bin/bash

set -e
set -x

# Download a small GGUF model for testing the embedded LLM
# This downloads Qwen 2.5 0.5B Instruct Q4_K_M (~300MB)

MODEL_DIR="$HOME/.file-organizer/models"
MODEL_NAME="qwen2.5-0.5b-instruct-q4_k_m.gguf"
MODEL_URL="https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf"

echo "============================================"
echo "Downloading test model for embedded LLM"
echo "============================================"
echo "Model: Qwen 2.5 0.5B Instruct Q4_K_M"
echo "Size: ~300MB"
echo "Target: $MODEL_DIR/$MODEL_NAME"
echo ""

# Create directory if it doesn't exist
mkdir -p "$MODEL_DIR"

# Download the model
echo "Starting download..."
echo ""

if command -v curl &> /dev/null; then
    curl -L -o "$MODEL_DIR/$MODEL_NAME" \
         --progress-bar \
         "$MODEL_URL"
elif command -v wget &> /dev/null; then
    wget -O "$MODEL_DIR/$MODEL_NAME" \
         --show-progress \
         "$MODEL_URL"
else
    echo "Error: Neither curl nor wget found. Please install one of them."
    exit 1
fi

# Check if download was successful
if [ -f "$MODEL_DIR/$MODEL_NAME" ]; then
    echo ""
    echo "✅ Download complete!"
    echo ""
    echo "Model path: $MODEL_DIR/$MODEL_NAME"
    echo ""
    echo "Next steps:"
    echo "1. Open the File Organizer app"
    echo "2. Select 'Embedded (beta)' as your LLM provider"
    echo "3. Set the model path to: $MODEL_DIR/$MODEL_NAME"
    echo "4. Click 'Load Model'"
    echo "5. Click 'Test Connection'"
    echo ""
else
    echo ""
    echo "❌ Download failed. Please check your internet connection and try again."
    exit 1
fi

