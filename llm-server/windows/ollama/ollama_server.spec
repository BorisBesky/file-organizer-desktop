# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_dynamic_libs

# Bundle llama_cpp shared libraries so the runtime loader can find them.
llama_binaries = collect_dynamic_libs('llama_cpp', destdir='llama_cpp/lib')

a = Analysis(
    ['ollama_server.py'],
    pathex=[],
    binaries=llama_binaries,
    datas=[('version.py', '.')],
    hiddenimports=[
        'llama_cpp',
        'anyio',
        'fastapi',
        'starlette',
        'sse_starlette',
        'pydantic',
        'pydantic_settings',
        'starlette_context',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='ollama_server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='ollama_server',
)
