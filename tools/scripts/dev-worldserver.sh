#!/usr/bin/env bash
# Run world server locally for development

set -e

GAME_KEY=${1:-cyberia}
WORLD_ID=${2:-local}

echo "Starting local world server..."
echo "Game: $GAME_KEY"
echo "World ID: $WORLD_ID"

cd packages/drawvid-worldserver

# Set environment variables
export GAME_KEY=$GAME_KEY
export WORLD_ID=$WORLD_ID
export WORLD_STORE_MODE=memory
export JWT_SECRET=dev-local-secret-change-in-production

# Run
pnpm dev
