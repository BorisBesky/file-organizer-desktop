from llama_cpp import Llama
import os
import sys

if len(sys.argv) < 2:
    print("Usage: python test.py <model_path>")
    sys.exit(1)

# Set the path to your GGUF model file
model_path = sys.argv[1]
if not os.path.exists(model_path):
    print(f"Model file {model_path} does not exist")
    sys.exit(1)

llm = Llama(
    model_path=model_path,
    n_gpu_layers=-1, # Offload all layers to the GPU
    verbose=True
)

# Run a simple inference
output = llm("Q: What is your name? A: ", max_tokens=100)
print(output)
