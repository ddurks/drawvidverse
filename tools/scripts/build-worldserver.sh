#!/usr/bin/env bash
# Build and push world server Docker image to ECR

set -e

REPO_URI=$1

if [ -z "$REPO_URI" ]; then
  echo "Usage: ./build-worldserver.sh <ecr-repo-uri>"
  echo "Example: ./build-worldserver.sh 123456789012.dkr.ecr.us-east-2.amazonaws.com/drawvidverse-worldserver"
  exit 1
fi

# Get the script directory and resolve to workspace root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
WORKSPACE_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"

echo "Building world server..."
cd "$WORKSPACE_ROOT"

# Build TypeScript
cd packages/drawvid-worldserver
pnpm build

# Go back to workspace root for Docker build
cd "$WORKSPACE_ROOT"

# Build container image (from workspace root so Dockerfile can access workspace files)
podman build -f packages/drawvid-worldserver/Dockerfile -t drawvidverse-worldserver:latest .

# Tag for ECR
podman tag drawvidverse-worldserver:latest $REPO_URI:latest

echo "Pushing to ECR..."
# Get login token
aws ecr get-login-password --region ${AWS_REGION:-us-east-2} | podman login --username AWS --password-stdin $REPO_URI

# Push
podman push $REPO_URI:latest

echo "Done! Image pushed to $REPO_URI:latest"
