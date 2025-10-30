# run_server.py
import os
import sys
import argparse
from huggingface_hub import hf_hub_download
from llama_cpp import Llama
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import uvicorn

# Fix for PyInstaller with console=False: ensure stdout/stderr are not None
# This prevents uvicorn logging from failing when checking isatty()
if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w')
if sys.stderr is None:
    sys.stderr = open(os.devnull, 'w')

try:
    from version import __version__, __build_date__
except ImportError:
    __version__ = "dev"
    __build_date__ = "unknown"


# Default model paths from Hugging Face
# "ClarityClips/ClarityQwen2Summarizer" #  "tiiuae/Falcon-H1-0.5B-Instruct-GGUF"
# "Qwen2-7B-Summarizer.gguf"  # "falcon-h1-0.5b-instruct.gguf"
default_model_id = "MaziyarPanahi/gemma-3-1b-it-GGUF"
default_filename = "gemma-3-1b-it.Q8_0.gguf"
default_port = 8000
default_log_level = "info"
default_host = "127.0.0.1"
default_n_gpu_layers = -1

# Parse command-line arguments
def parse_args():
    parser = argparse.ArgumentParser(
        description="Llama.cpp Server with FastAPI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Environment variables (overridden by command-line arguments):
  SERVER_MODEL        Model to use (default: %(default_model)s)
  SERVER_FILENAME     Filename to use (default: %(default_filename)s)
  SERVER_MODEL_PATH   Path to externally provided model (skips download)
  SERVER_PORT         Port to listen on (default: %(default_port)s)
  SERVER_LOG_LEVEL    Log level (default: %(default_log_level)s)
  SERVER_HOST         Host to listen on (default: %(default_host)s)
  SERVER_N_GPU_LAYERS Number of GPU layers to use (default: %(default_n_gpu_layers)s)
        """ % {
            'default_model': default_model_id,
            'default_filename': default_filename,
            'default_port': default_port,
            'default_log_level': default_log_level,
            'default_host': default_host,
            'default_n_gpu_layers': default_n_gpu_layers
        }
    )
    
    parser.add_argument(
        '--version', '-v',
        action='version',
        version=f'ollama_server version {__version__} (build date: {__build_date__})'
    )
    
    parser.add_argument(
        '--model', '--model-id',
        type=str,
        help=f'Hugging Face model ID to download (default: {default_model_id})'
    )
    
    parser.add_argument(
        '--filename',
        type=str,
        help=f'Model filename to download (default: {default_filename})'
    )
    
    parser.add_argument(
        '--model-path',
        type=str,
        help='Path to local model file (skips download from Hugging Face)'
    )
    
    parser.add_argument(
        '--port', '-p',
        type=int,
        help=f'Port to listen on (default: {default_port})'
    )
    
    parser.add_argument(
        '--host',
        type=str,
        help=f'Host address to bind to (default: {default_host})'
    )
    
    parser.add_argument(
        '--log-level',
        type=str,
        choices=['critical', 'error', 'warning', 'info', 'debug', 'trace'],
        help=f'Logging level (default: {default_log_level})'
    )
    
    parser.add_argument(
        '--n-gpu-layers',
        type=int,
        help=f'Number of GPU layers to use (default: {default_n_gpu_layers})'
    )
    
    return parser.parse_args()

# Initialize with command-line args, environment variables, or defaults
# Priority: command-line args > environment variables > defaults
args = parse_args()

model_path_arg = args.model_path or os.environ.get('SERVER_MODEL_PATH')

if not model_path_arg:
    model_id = args.model or os.environ.get('SERVER_MODEL', default_model_id)
    filename = args.filename or os.environ.get('SERVER_FILENAME', default_filename)
    model_path = hf_hub_download(repo_id=model_id, filename=filename)
    print(f"Downloaded {model_id} file to: {model_path}")
else:
    model_path = model_path_arg
    print(f"Using {model_path} model")

port_number = args.port if args.port is not None else int(os.environ.get('SERVER_PORT', default_port))
log_level = args.log_level or os.environ.get('SERVER_LOG_LEVEL', default_log_level)
hostname = args.host or os.environ.get('SERVER_HOST', default_host)
n_gpu_layers = args.n_gpu_layers or int(os.environ.get('SERVER_N_GPU_LAYERS', default_n_gpu_layers))

# Initialize the Llama model once
llama = Llama(
    model_path=model_path,
    n_ctx=2048,
    n_batch=512,
    n_gpu_layers=n_gpu_layers,
    verbose=True,
)

# Request/Response models
class Message(BaseModel):
    role: str
    content: str

class ChatCompletionRequest(BaseModel):
    model: Optional[str] = None
    messages: List[Message]
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = 512
    stream: Optional[bool] = False

class ChatCompletionResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: List[Dict[str, Any]]
    usage: Dict[str, int]

# Create FastAPI app
app = FastAPI(title="Llama.cpp Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/v1/chat/completions")
async def create_chat_completion(request: ChatCompletionRequest):
    try:
        # Reset the KV cache to avoid position mismatch errors
        llama.reset()
        
        # Create the response using the Llama instance
        response = llama.create_chat_completion(
            messages=[msg.dict() for msg in request.messages],
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            stream=request.stream,
        )
        
        return response
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": model_path,
                "object": "model",
                "created": os.path.getmtime(model_path),
                "owned_by": "user",
            }
        ]
    }

if __name__ == "__main__":
    # Log version on startup
    print(f"Starting ollama_server v{__version__} (build date: {__build_date__})")
    print(f"Server configuration:")
    print(f"  Model: {model_path}")
    print(f"  Host: {hostname}")
    print(f"  Port: {port_number}")
    print(f"  Log Level: {log_level}")
    uvicorn.run(app, host=hostname, port=port_number, log_level=log_level)
