#!/usr/bin/env bash
# Destroy the CDK stack (matchmaker + world server infrastructure)
#
# WARNING: This will delete:
#   - DynamoDB table with all world state
#   - API Gateway WebSocket
#   - All Lambda functions
#   - ECS cluster, tasks, and services
#   - Network Load Balancer
#   - All related IAM roles and security groups
#
# This cannot be undone!
#
# Usage:
#   ./tools/scripts/destroy-backend.sh
#   ./tools/scripts/destroy-backend.sh --confirm  # Skip confirmation

set -e

WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "================================"
echo "⚠️  DESTROY BACKEND INFRASTRUCTURE"
echo "================================"
echo ""
echo "This will DELETE:"
echo "  - DynamoDB table (world state)"
echo "  - API Gateway WebSocket"
echo "  - Lambda functions"
echo "  - ECS cluster & tasks"
echo "  - Network Load Balancer"
echo "  - IAM roles & security groups"
echo ""
echo "This CANNOT be undone!"
echo ""

if [[ "$1" != "--confirm" ]]; then
  read -p "Type 'destroy' to confirm: " confirmation
  if [[ "$confirmation" != "destroy" ]]; then
    echo "❌ Aborted"
    exit 1
  fi
fi

echo ""
echo "🗑️  Destroying CDK stack..."
cd "$WORKSPACE_ROOT/packages/drawvid-matchmaker/infra"
npx cdk destroy --force

echo ""
echo "✅ Backend destroyed!"
echo ""
echo "Rebuild with:"
echo "  ./tools/scripts/deploy-matchmaker.sh"
