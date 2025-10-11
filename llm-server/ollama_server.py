# run_server.py
import subprocess
import os

# Path to the bundled model at runtime
model_path = os.path.join(os.path.dirname(__file__), 'model.gguf')

subprocess.run([
    "python", "-m", "llama_cpp.server", "--model", model_path
])