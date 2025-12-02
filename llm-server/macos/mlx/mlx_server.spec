# -*- mode: python ; coding: utf-8 -*-
import os
import sys
from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

# Collect MLX metallib and binary files
mlx_datas = []
mlx_binaries = []

try:
    import mlx
    import importlib.util
    
    # Try to get MLX path using multiple methods
    mlx_path = None
    if hasattr(mlx, '__file__') and mlx.__file__:
        mlx_path = os.path.dirname(mlx.__file__)
    elif hasattr(mlx, '__path__'):
        mlx_path = mlx.__path__[0]
    else:
        # Fallback: use importlib to find the spec
        spec = importlib.util.find_spec('mlx')
        if spec and spec.origin:
            mlx_path = os.path.dirname(spec.origin)
    
    if not mlx_path:
        raise ImportError("Could not determine MLX installation path")
    
    print(f"Found MLX at: {mlx_path}")
    
    # Walk through MLX directory to find all necessary files
    for root, dirs, files in os.walk(mlx_path):
        for file in files:
            full_path = os.path.join(root, file)
            rel_path = os.path.relpath(root, mlx_path)
            
            # Determine target directory in bundle
            if rel_path == '.':
                target_dir = 'mlx'
            else:
                target_dir = os.path.join('mlx', rel_path)
            
            # Categorize files
            if file.endswith('.metallib'):
                # Metal shader libraries - critical for MLX
                mlx_datas.append((full_path, target_dir))
                print(f"Added metallib: {file} -> {target_dir}")
            elif file.endswith(('.dylib', '.so')):
                # Shared libraries - add as binaries
                mlx_binaries.append((full_path, target_dir))
                print(f"Added binary: {file} -> {target_dir}")
                # Also add to root for @rpath resolution
                if 'libmlx' in file:
                    mlx_binaries.append((full_path, '.'))
                    print(f"Added {file} to root for @rpath")
            elif file.startswith('_mlx') and file.endswith('.so'):
                # MLX C++ extensions
                mlx_binaries.append((full_path, target_dir))
                print(f"Added extension: {file} -> {target_dir}")

except ImportError as e:
    print(f"Warning: Could not import MLX: {e}")
    print("MLX files may not be included in bundle")

print(f"\nTotal MLX binaries: {len(mlx_binaries)}")
print(f"Total MLX data files: {len(mlx_datas)}")

# Collect all MLX-LM model modules dynamically
mlx_model_imports = []
try:
    import mlx_lm.models
    import pkgutil
    for _, name, _ in pkgutil.iter_modules(mlx_lm.models.__path__):
        mlx_model_imports.append(f'mlx_lm.models.{name}')
    print(f"Found {len(mlx_model_imports)} MLX model modules")
except Exception as e:
    print(f"Warning: Could not enumerate MLX model modules: {e}")

# Collect all transformers model modules dynamically
transformers_model_imports = []
try:
    import transformers.models
    for _, name, _ in pkgutil.iter_modules(transformers.models.__path__):
        transformers_model_imports.append(f'transformers.models.{name}')
    print(f"Found {len(transformers_model_imports)} transformers model modules")
except Exception as e:
    print(f"Warning: Could not enumerate transformers model modules: {e}")

# Collect certifi certificate bundle
certifi_datas = []
try:
    import certifi
    cacert_path = certifi.where()
    if os.path.exists(cacert_path):
        certifi_datas.append((cacert_path, 'certifi'))
        print(f"Added certifi bundle: {cacert_path}")
except Exception as e:
    print(f"Warning: Could not find certifi bundle: {e}")

# Use PyInstaller's collect_all for tokenizers
print("Collecting tokenizers package using collect_all...")
tokenizers_datas_tuple, tokenizers_binaries_tuple, tokenizers_hiddenimports = collect_all('tokenizers')
# Convert to lists so we can append
tokenizers_datas_tuple = list(tokenizers_datas_tuple)
tokenizers_binaries_tuple = list(tokenizers_binaries_tuple)
tokenizers_hiddenimports = list(tokenizers_hiddenimports)
print(f"Collected {len(tokenizers_datas_tuple)} tokenizers data files")
print(f"Collected {len(tokenizers_binaries_tuple)} tokenizers binaries")
print(f"Collected {len(tokenizers_hiddenimports)} tokenizers hidden imports")

# Explicitly add the tokenizers compiled extension (critical!)
try:
    import tokenizers
    import glob
    tokenizers_path = os.path.dirname(tokenizers.__file__)
    tokenizers_so_files = []
    for pattern in ['tokenizers.*.so', 'tokenizers.*.dylib', 'tokenizers.*.pyd']:
        tokenizers_so_files.extend(glob.glob(os.path.join(tokenizers_path, pattern)))
    
    if tokenizers_so_files:
        for so_file in tokenizers_so_files:
            # Check if not already in the list
            if not any(so_file in str(b) for b in tokenizers_binaries_tuple):
                tokenizers_binaries_tuple.append((so_file, 'tokenizers'))
                print(f"Explicitly added tokenizers extension: {os.path.basename(so_file)}")
    else:
        print("Warning: Could not find tokenizers compiled extension!")
except Exception as e:
    print(f"Warning: Could not add tokenizers extension: {e}")

# Collect transformers - use Tree to copy the whole package as-is
print("Collecting transformers package as a Tree (copying entire source)...")
import transformers
transformers_path = os.path.dirname(transformers.__file__)
print(f"Transformers location: {transformers_path}")

# Collect ALL submodules for hidden imports
transformers_hiddenimports = collect_submodules('transformers')
print(f"Collected {len(transformers_hiddenimports)} transformers submodules for hidden imports")

# Also use collect_all for data files and binaries
transformers_datas_tuple, transformers_binaries_tuple, _ = collect_all('transformers')
print(f"Collected {len(transformers_datas_tuple)} transformers data files")
print(f"Collected {len(transformers_binaries_tuple)} transformers binaries")

# Base hidden imports
base_hiddenimports = [
    'mlx._reprlib_fix',
    'mlx._os_warning',
    'mlx._version',
    'mlx._mlx',
    'mlx.core',
    'mlx.nn',
    'mlx.optimizers',
    'mlx.utils',
    'mlx_lm',
    'mlx_lm.server',
    'mlx_lm.convert',
    'mlx_lm.generate',
    'mlx_lm.load',
    'mlx_lm.models',
    'mlx_lm.tuner',
    'mlx_lm.utils',
    'transformers',
    'torch',
    'numpy',
    'huggingface_hub',
    'safetensors',
    'tokenizers',
    'tokenizers.tokenizers',  # Critical tokenizers extension module
    'tqdm',
    'requests',
    'urllib3',
    '_socket',  # Required for multiprocessing
    'socket',
    'multiprocessing',
    'multiprocessing.spawn',
    'multiprocessing.forkserver',
    'multiprocessing.popen_spawn_posix',
    # Transformers specific imports that are often missed
    'transformers.models.encoder_decoder',
    'transformers.models.encoder_decoder.configuration_encoder_decoder',
    'transformers.models.encoder_decoder.modeling_encoder_decoder',
    'transformers.configuration_utils',
    'transformers.modeling_utils',
]

a = Analysis(
    ['mlx_server.py'],
    pathex=[],
    binaries=mlx_binaries + tokenizers_binaries_tuple + transformers_binaries_tuple,
    datas=mlx_datas + certifi_datas + tokenizers_datas_tuple + transformers_datas_tuple + [('version.py', '.')],
    hiddenimports=base_hiddenimports + mlx_model_imports + transformers_model_imports + tokenizers_hiddenimports + transformers_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=['hook-mlx.py', 'hook-transformers.py'],
    excludes=[],
    noarchive=False,
    optimize=0,
)

# Add the entire transformers package as a Tree to preserve its structure
transformers_tree = Tree(transformers_path, prefix='transformers', excludes=['__pycache__', '*.pyc', '*.pyo'])
print(f"Added transformers Tree from {transformers_path}")

pyz = PYZ(a.pure)

# Get codesign identity from environment variable
codesign_identity = os.environ.get('APPLE_SIGNING_IDENTITY')
if codesign_identity:
    print(f"Signing with identity: {codesign_identity}")
else:
    print("No signing identity found in environment variable APPLE_SIGNING_IDENTITY")

# Use onedir mode instead of onefile for better multiprocessing support
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,  # Key change for onedir mode
    name='mlx_server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # Disable UPX for better compatibility
    console=True,  # Enable console for now to see output
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=codesign_identity,
    entitlements_file='entitlements.plist',
)

# COLLECT creates a directory with all files (onedir mode)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    transformers_tree,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='mlx_server',
)
