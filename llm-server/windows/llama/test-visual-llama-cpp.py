from llama_cpp import Llama
from llama_cpp.llama_chat_format import Qwen25VLChatHandler

chat_handler = Qwen25VLChatHandler.from_pretrained(
  repo_id="unsloth/Qwen2.5-VL-3B-Instruct-GGUF",
  filename="mmproj-F16.gguf",
)

llm = Llama.from_pretrained(
  repo_id="unsloth/Qwen2.5-VL-3B-Instruct-GGUF",
  filename="Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf",
  chat_handler=chat_handler,
  n_ctx=2048, # n_ctx should be increased to accommodate the image embedding
)

response = llm.create_chat_completion(
    messages = [
        {
            "role": "user",
            "content": [
                {"type" : "text", "text": "What's in this image?"},
                {"type": "image_url", "image_url": 
                {"url": 
                "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/2560px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg" } }
            ]
        }
    ]
)
print(response)