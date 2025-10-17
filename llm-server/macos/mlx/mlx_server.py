import os
import sys
import argparse
from mlx_lm import server

try:
    from version import __version__, __build_date__
except ImportError:
    __version__ = "dev"
    __build_date__ = "unknown"


# Default configuration
default_model = "mlx-community/Phi-3.5-mini-instruct-4bit"
default_host = "127.0.0.1"
default_port = 8000
default_log_level = "info"

# Parse command-line arguments
def parse_args():
    parser = argparse.ArgumentParser(
        description="MLX LM Server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Environment variables (overridden by command-line arguments):
  SERVER_MODEL      Model to use (default: %(default_model)s)
  SERVER_HOST       Host to listen on (default: %(default_host)s)
  SERVER_PORT       Port to listen on (default: %(default_port)s)
  SERVER_LOG_LEVEL  Log level (default: %(default_log_level)s)
        """ % {
            'default_model': default_model,
            'default_host': default_host,
            'default_port': default_port,
            'default_log_level': default_log_level
        }
    )
    
    parser.add_argument(
        '--version', '-v',
        action='version',
        version=f'mlx_server version {__version__} (build date: {__build_date__})'
    )
    
    parser.add_argument(
        '--model',
        type=str,
        help=f'Model to use (default: {default_model})'
    )
    
    parser.add_argument(
        '--host',
        type=str,
        help=f'Host address to bind to (default: {default_host})'
    )
    
    parser.add_argument(
        '--port', '-p',
        type=int,
        help=f'Port to listen on (default: {default_port})'
    )
    
    parser.add_argument(
        '--log-level',
        type=str,
        choices=['critical', 'error', 'warning', 'info', 'debug'],
        help=f'Logging level (default: {default_log_level})'
    )
    
    return parser.parse_args()


def build_argv_from_config(model, host, port, log_level):
    """Build argv for mlx_lm.server from configuration values.
    
    Args:
        model: Model to use
        host: Host to listen on
        port: Port to listen on
        log_level: Logging level
    
    Returns:
        List of command-line arguments for mlx_lm.server
    """
    argv = [
        "mlx_server.py",
        "--model", model,
        "--host", host,
        "--port", str(port),
    ]
    
    # Note: mlx_lm.server may not support --log-level directly
    # If it does, uncomment the following lines:
    # if log_level:
    #     argv.extend(["--log-level", log_level])
    
    return argv


if __name__ == "__main__":
    # Ensure compatibility with frozen apps/multiprocessing child processes
    try:
        import multiprocessing as _mp
        _mp.freeze_support()
    except Exception:
        pass

    # Initialize with command-line args, environment variables, or defaults
    # Priority: command-line args > environment variables > defaults
    args = parse_args()
    
    model = args.model or os.environ.get('SERVER_MODEL', default_model)
    hostname = args.host or os.environ.get('SERVER_HOST', default_host)
    port_number = args.port if args.port is not None else int(os.environ.get('SERVER_PORT', default_port))
    log_level = args.log_level or os.environ.get('SERVER_LOG_LEVEL', default_log_level)

    # Log version and configuration on startup
    print(f"Starting mlx_server v{__version__} (build date: {__build_date__})")
    print(f"Server configuration:")
    print(f"  Model: {model}")
    print(f"  Host: {hostname}")
    print(f"  Port: {port_number}")
    print(f"  Log Level: {log_level}")
    
    # Build argv and start the MLX server
    sys.argv = build_argv_from_config(model, hostname, port_number, log_level)
    server.main()