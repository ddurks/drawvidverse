#!/usr/bin/env bash
# Deploy matchmaker CDK stack

set -e

GAME_KEY=${1:-cyberia}

echo "Deploying matchmaker for game: $GAME_KEY"

cd packages/drawvid-matchmaker

# Build Lambda code
echo "Building Lambda handlers..."
pnpm build

# Deploy CDK
echo "Deploying CDK stack..."
cd infra
pnpm install
cdk deploy --require-approval never

echo "Deployment complete!"
echo ""
echo "Next steps:"
echo "1. Build and push world server image:"
echo "   ./tools/scripts/build-worldserver.sh <ecr-repo-uri>"
echo "2. Connect to WebSocket API URL (see outputs above)"
