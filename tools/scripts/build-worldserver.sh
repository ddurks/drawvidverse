#!/usr/bin/env bash
# Build and push world server Docker image to ECR

set -e

REPO_URI=$1

if [ -z "$REPO_URI" ]; then
  echo "Usage: ./build-worldserver.sh <ecr-repo-uri>"
  echo "Example: ./build-worldserver.sh 123456789012.dkr.ecr.us-east-2.amazonaws.com/drawvidverse-worldserver"
  exit 1
fi

echo "Building world server..."
cd ../packages/drawvid-worldserver

# Build TypeScript
pnpm build

# Build Docker image
docker build -t drawvidverse-worldserver:latest .

# Tag for ECR
docker tag drawvidverse-worldserver:latest $REPO_URI:latest

echo "Pushing to ECR..."
# Get login token
aws ecr get-login-password --region ${AWS_REGION:-us-east-2} | docker login --username AWS --password-stdin $REPO_URI

# Push
docker push $REPO_URI:latest

echo "Done! Image pushed to $REPO_URI:latest"
