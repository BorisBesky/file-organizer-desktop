import os
import sys
from mlx_lm import server


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
    # Ensure compatibility with frozen apps/multiprocessing child processes
    try:
        import multiprocessing as _mp
        _mp.freeze_support()
    except Exception:
        pass

    sys.argv = build_argv_from_env()
    server.main()