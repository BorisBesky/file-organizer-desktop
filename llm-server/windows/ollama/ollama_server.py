# run_server.py
import os
import sys
from huggingface_hub import hf_hub_download
from llama_cpp import Llama
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import uvicorn

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
default_port = "8000"
default_log_level = "info"
default_host = "127.0.0.1"

if not os.environ.get('OLLAMA_MODEL_PATH'):
    model_id = os.environ.get('OLLAMA_MODEL', default_model_id) 
    filename = os.environ.get('OLLAMA_FILENAME', default_filename)  
    model_path = hf_hub_download(repo_id=model_id, filename=filename)
    print(f"Downloaded {model_id} file to: {model_path}")
else:
    model_path = os.environ.get('OLLAMA_MODEL_PATH')
    print(f"Using {model_path} model")

port_number = int(os.environ.get('OLLAMA_PORT', default_port))
log_level = os.environ.get('OLLAMA_LOG_LEVEL', default_log_level)
hostname = os.environ.get('OLLAMA_HOST', default_host)

# Initialize the Llama model once
llama = Llama(
    model_path=model_path,
    n_ctx=2048,
    n_batch=512,
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
    # Handle command-line arguments
    if len(sys.argv) > 1:
        if sys.argv[1] in ["--version", "-v"]:
            print(f"ollama_server version {__version__} (build date: {__build_date__})")
            exit(0)
        elif sys.argv[1] in ["--help", "-h", "--h", "/?"]:
            print(f"Usage: {sys.argv[0]} ")
            print("Options:")
            print("  --help, -h, --h, /?        Show this help message and exit")
            print("  --version, -v              Show version information and exit")
            print("Environment variables:")
            print(f"  OLLAMA_MODEL               Model to use (default: {default_model_id}). The model will be downloaded from Hugging Face on first run.")
            print(f"  OLLAMA_FILENAME            Filename to use (default: {default_filename}). The model will be downloaded from Hugging Face on first run.")
            print("  OLLAMA_MODEL_PATH          Path to externally provided model (default: None). The model will not be downloaded from Hugging Face.")
            print(f"  OLLAMA_PORT                Port to listen on (default: {default_port})")
            print(f"  OLLAMA_LOG_LEVEL           Log level (default: {default_log_level})")
            print(f"  OLLAMA_HOST                Host to listen on (default: {default_host}).")
            exit(0)
    
    # Log version on startup
    print(f"Starting ollama_server v{__version__} (build date: {__build_date__})")
    uvicorn.run(app, host=hostname, port=port_number, log_level=log_level)
