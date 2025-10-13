# run_server.py
import os
import llama_cpp.server

# Path to the bundled model at runtime
model_path = os.path.join(os.path.dirname(__file__), 'model.gguf')

llama_cpp.server.run()