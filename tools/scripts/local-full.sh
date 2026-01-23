#!/usr/bin/env bash
# Run both world server and local matchmaker together

set -e

GAME_KEY=${1:-cyberia}

echo "🚀 Starting local development environment..."
echo "Game: $GAME_KEY"
echo ""
echo "This will start:"
echo "  - World server on ws://localhost:7777"
echo "  - Local matchmaker on ws://localhost:8080"
echo ""

# Check if dependencies are installed
if ! command -v pnpm &> /dev/null; then
  echo "❌ pnpm not found. Please install it first:"
  echo "   npm install -g pnpm"
  exit 1
fi

# Build if needed
if [ ! -d "packages/drawvid-worldserver/dist" ]; then
  echo "📦 Building world server..."
  cd packages/drawvid-worldserver
  pnpm install
  pnpm build
  cd ../..
fi

# Create a temporary script to run both
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP_RUNNER="$SCRIPT_DIR/.local-runner.sh"

cat > "$TEMP_RUNNER" << 'EOF'
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
EOF

chmod +x "$TEMP_RUNNER"

# Run it
cd "$SCRIPT_DIR/../.."
"$TEMP_RUNNER" "$GAME_KEY"
