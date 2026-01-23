#!/usr/bin/env bash

# Kill all child processes on exit
trap 'kill $(jobs -p) 2>/dev/null' EXIT

# Start world server
echo "🌍 Starting world server..."
cd packages/drawvid-worldserver
GAME_KEY="$1" WORLD_ID=local WORLD_STORE_MODE=memory JWT_SECRET=dev-local-secret-change-in-production pnpm dev &
WORLDSERVER_PID=$!

# Wait for world server to start
sleep 3

# Start local matchmaker
echo ""
echo "🎮 Starting local matchmaker..."
cd ../../tools/scripts
node local-matchmaker.js &
MATCHMAKER_PID=$!

echo ""
echo "✅ Local environment ready!"
echo ""
echo "📍 Connect your client to: ws://localhost:8080"
echo ""
echo "Test with:"
echo "  node tools/scripts/test-client.js ws://localhost:8080"
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

# Wait for any process to exit
wait
