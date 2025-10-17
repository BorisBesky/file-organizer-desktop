#!/bin/bash

HOST=${SERVER_HOST:-127.0.0.1}
PORT=${SERVER_PORT:-8000}

./dist/mlx_server/mlx_server > /tmp/mlx_server_test.log 2>&1 &
SERVER_PID=$!
echo "Server started with PID: $SERVER_PID"
sleep 15
echo ""
echo "=== Checking if server is still running ==="
if ps -p $SERVER_PID > /dev/null 2>&1; then
    echo "✓ Server is running!"
    echo ""
    echo "=== Testing server ==="
    curl -s "http://$HOST:$PORT/health" && echo "" || echo "Health check failed"
    echo ""
    echo "=== Killing server ==="
    kill $SERVER_PID 2>/dev/null
    wait $SERVER_PID 2>/dev/null || true
else
    echo "✗ Server crashed"
fi
echo ""
echo "=== Full server log ==="
cat /tmp/mlx_server_test.log
echo ""
echo "=== Done ==="