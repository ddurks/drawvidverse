#!/usr/bin/env bash
# Deploy matchmaker backend via CDK
#
# This script builds the matchmaker TypeScript code and deploys the CDK stack,
# which includes:
#   - DynamoDB table for world state
#   - API Gateway WebSocket for matchmaker communication
#   - Lambda functions (connect, disconnect, join, create world, etc)
#   - ECS cluster for world server tasks
#   - NLB for world server routing
#   - IAM roles and security groups
#
# Usage:
#   ./tools/scripts/deploy-matchmaker.sh
#
# Outputs:
#   - WebSocket URL: wss://matchmaker.drawvid.com/
#   - World Server URL: wss://world.drawvid.com:443
#   - DynamoDB table name
#   - ECS cluster ARN

set -e

WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "================================"
echo "🚀 Deploying Matchmaker Backend"
echo "================================"

# Step 1: Build TypeScript
echo ""
echo "📦 Building TypeScript..."
cd "$WORKSPACE_ROOT"
npm run build

# Step 2: Deploy CDK
echo ""
echo "🚀 Deploying CDK stack..."
cd "$WORKSPACE_ROOT/packages/drawvid-matchmaker/infra"
npx cdk deploy --all --require-approval never

echo ""
echo "✅ Matchmaker backend deployed!"
echo ""
echo "Next: Deploy world server image"
echo "  ./tools/scripts/build-worldserver.sh <ecr-repo-uri>"
