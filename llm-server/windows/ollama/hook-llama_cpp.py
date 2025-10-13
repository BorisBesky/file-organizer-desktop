# hook-llama_cpp.py
from PyInstaller.utils.hooks import collect_dynamic_libs

# Ensure llama_cpp binary dependencies ship beside the package so runtime loading succeeds.
raise RuntimeError('hook executed')
hiddenimports = ['llama_cpp']
binaries = collect_dynamic_libs('llama_cpp', destdir='llama_cpp/lib')
