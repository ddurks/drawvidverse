#!/bin/bash

# Start both services in the background
echo "🚀 Starting world server..."
cd "$PWD/packages/drawvid-worldserver"
JWT_SECRET=local-dev-secret-key GAME_KEY=cyberia WORLD_ID=local WORLD_STORE_MODE=memory npm run dev &
WORLD_PID=$!

echo "🚀 Starting frontend..."
cd /Users/onlinedavid/code/cyberia
npm run dev &
FE_PID=$!

# Wait for Vite to start, then open browser
sleep 3
echo "🌐 Opening browser..."
open -a "Google Chrome" "http://localhost:3000"

# Keep script running and handle Ctrl+C to kill both processes
trap "echo '🛑 Stopping services...'; kill $WORLD_PID $FE_PID 2>/dev/null; exit" INT TERM

echo "✅ Services running (Ctrl+C to stop)"
echo "   World Server PID: $WORLD_PID"
echo "   Frontend PID: $FE_PID"
wait
