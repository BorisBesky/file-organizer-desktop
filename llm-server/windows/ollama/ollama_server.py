# run_server.py
import os
from huggingface_hub import hf_hub_download
from llama_cpp import Llama
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import uvicorn

model_id = "tiiuae/Falcon-H1-0.5B-Instruct-GGUF"
filename = "Falcon-H1-0.5B-Instruct-Q4_K_M.gguf"

file_path = hf_hub_download(repo_id=model_id, filename=filename)
print(f"Downloaded file to: {file_path}")

# Path to the bundled model at runtime
model_name = os.environ.get('OLLAMA_MODEL', file_path)
port_number = int(os.environ.get('OLLAMA_PORT', '8000'))
log_level = os.environ.get('OLLAMA_LOG_LEVEL', 'info')
hostname = os.environ.get('OLLAMA_HOST', '127.0.0.1')

# Initialize the Llama model once
llama = Llama(
    model_path=model_name,
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
                "id": model_name,
                "object": "model",
                "created": 1234567890,
                "owned_by": "organization",
            }
        ]
    }

if __name__ == "__main__":
    uvicorn.run(app, host=hostname, port=port_number, log_level=log_level)
