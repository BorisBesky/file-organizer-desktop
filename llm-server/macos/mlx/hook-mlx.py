# PyInstaller runtime hook for MLX
# This sets up the library path so MLX can find its dylib

import os
import sys

# In PyInstaller onefile mode, files are extracted to _MEIPASS
if hasattr(sys, '_MEIPASS'):
    meipass = sys._MEIPASS
    
    # Add MLX lib directory to DYLD_LIBRARY_PATH
    mlx_lib_path = os.path.join(meipass, 'mlx', 'lib')
    
    if os.path.exists(mlx_lib_path):
        # Set DYLD_LIBRARY_PATH for macOS
        current_path = os.environ.get('DYLD_LIBRARY_PATH', '')
        if current_path:
            os.environ['DYLD_LIBRARY_PATH'] = f"{mlx_lib_path}:{current_path}"
        else:
            os.environ['DYLD_LIBRARY_PATH'] = mlx_lib_path
        
        print(f"[PyInstaller Hook] Set DYLD_LIBRARY_PATH to include {mlx_lib_path}")
    else:
        print(f"[PyInstaller Hook] Warning: MLX lib path not found: {mlx_lib_path}")
    
    # Also add MEIPASS root and mlx directory
    os.environ['DYLD_LIBRARY_PATH'] = f"{meipass}:{os.path.join(meipass, 'mlx')}:{os.environ.get('DYLD_LIBRARY_PATH', '')}"
    print(f"[PyInstaller Hook] DYLD_LIBRARY_PATH={os.environ.get('DYLD_LIBRARY_PATH')}")

