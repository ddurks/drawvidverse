#!/bin/bash

# Start all three services in separate Terminal tabs with Vite for HMR
osascript \
  -e 'tell application "Terminal" to do script "cd '"$PWD"' && JWT_SECRET=local-dev-secret-key node tools/scripts/local-matchmaker.js"' \
  -e 'tell application "Terminal" to do script "cd '"$PWD"'/packages/drawvid-worldserver && JWT_SECRET=local-dev-secret-key GAME_KEY=cyberia WORLD_ID=local WORLD_STORE_MODE=memory npm run dev"' \
  -e 'tell application "Terminal" to do script "cd /Users/onlinedavid/code/cyberia && npm run dev"'
