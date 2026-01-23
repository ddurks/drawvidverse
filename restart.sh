#!/bin/bash

# Kill all related processes
echo "🛑 Stopping all services..."
pkill -f "local-matchmaker.js"
pkill -f "drawvid-worldserver"
pkill -f "vite.*3000"
pkill -f "python.*http.server.*3000"
sleep 1

echo "🚀 Starting all services..."
./start-all.sh

echo "✅ Done! Services starting in new terminal tabs."
echo "📝 Browser will auto-refresh when you save files (Vite HMR)"
