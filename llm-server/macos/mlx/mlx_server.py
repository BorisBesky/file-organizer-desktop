import os
import sys
from mlx_lm import server

try:
    from version import __version__, __build_date__
except ImportError:
    __version__ = "dev"
    __build_date__ = "unknown"


def build_argv_from_env():
    """Build argv for mlx_lm.server from environment variables.

    Recognized env vars:
    - MLX_SERVER_MODEL (default: mlx-community/Phi-3.5-mini-instruct-4bit)
    - MLX_SERVER_HOST  (default: 127.0.0.1)
    - MLX_SERVER_PORT  (default: 8080)
    """
    model = os.environ.get("MLX_SERVER_MODEL", "mlx-community/Phi-3.5-mini-instruct-4bit")
    host = os.environ.get("MLX_SERVER_HOST", "127.0.0.1")
    port = os.environ.get("MLX_SERVER_PORT", "8080")

    return [
        "mlx_server.py",
        "--model", model,
        "--host", host,
        "--port", port,
    ]


if __name__ == "__main__":
    # Handle command-line arguments
    if len(sys.argv) > 1:
        if sys.argv[1] in ["--version", "-v"]:
            print(f"mlx_server version {__version__} (build date: {__build_date__})")
            sys.exit(0)
        elif sys.argv[1] in ["--help", "-h", "--h", "/?"]:
            print(f"Usage: {sys.argv[0]} ")
            print("Options:")
            print("  --help, -h, --h, /?        Show this help message and exit")
            print("  --version, -v              Show version information and exit")
            print("Environment variables:")
            print("  MLX_SERVER_MODEL           Model to use (default: mlx-community/Phi-3.5-mini-instruct-4bit)")
            print("  MLX_SERVER_HOST            Host to listen on (default: 127.0.0.1)")
            print("  MLX_SERVER_PORT            Port to listen on (default: 8080)")
            sys.exit(0)
    
    # Ensure compatibility with frozen apps/multiprocessing child processes
    try:
        import multiprocessing as _mp
        _mp.freeze_support()
    except Exception:
        pass

    # Log version on startup
    print(f"Starting mlx_server v{__version__} (build date: {__build_date__})")
    
    sys.argv = build_argv_from_env()
    server.main()