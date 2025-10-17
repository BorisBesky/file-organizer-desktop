#!/bin/bash
# Simple wrapper to run mlx_server and prevent restarts

cd "$(dirname "$0")"

# Allow host/port override via env
HOST=${SERVER_HOST:-127.0.0.1}
PORT=${SERVER_PORT:-8000}

# Kill any existing instances
pkill -9 mlx_server 2>/dev/null

# Wait a moment
sleep 1

# Check if port is free
if lsof -Pi :"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    echo "❌ Port $PORT is already in use. Please kill the process first:"
    lsof -i :"$PORT"
    exit 1
fi

echo "🚀 Starting MLX Server..."
echo "   Server will be available at http://$HOST:$PORT"
echo "   Press Ctrl+C to stop"
echo ""

# Run the server - trap to ensure clean shutdown
trap 'echo ""; echo "Stopping server..."; pkill -9 mlx_server; exit 0' INT TERM

./dist/mlx_server/mlx_server

# If server exits, don't restart
echo ""
echo "Server stopped."

