# Deployment Guide

Complete guide for deploying drawvidverse to AWS.

## Prerequisites

- AWS CLI configured with credentials
- Node.js 20+
- pnpm 8+
- Docker
- AWS CDK CLI (`npm install -g aws-cdk`)

## Step 1: Install Dependencies

```bash
pnpm install
```

## Step 2: Build All Packages

```bash
pnpm build
```

## Step 3: Bootstrap CDK (First Time Only)

```bash
cd packages/drawvid-matchmaker/infra
cdk bootstrap
cd ../../..
```

## Step 4: Deploy Matchmaker Stack

```bash
./tools/scripts/deploy-matchmaker.sh cyberia
```

This creates:
- WebSocket API Gateway
- DynamoDB table for world/connection state
- ECS Fargate cluster
- ECR repository for world server image
- Lambda functions for lobby logic
- VPC with public subnets
- Security groups
- IAM roles and policies

Save the outputs:
- `WebSocketApiUrl` - Client connects here
- `WorldserverRepoUri` - ECR repository for Docker image
- `ClusterArn`, `TaskDefinitionArn` - For ECS

## Step 5: Build and Push World Server Image

Get the ECR URI from CDK outputs:

```bash
ECR_URI=$(aws cloudformation describe-stacks \
  --stack-name DrawvidVerseMatchmakerStack \
  --query 'Stacks[0].Outputs[?OutputKey==`WorldserverRepoUri`].OutputValue' \
  --output text)

echo $ECR_URI
```

Build and push:

```bash
./tools/scripts/build-worldserver.sh $ECR_URI
```

## Step 6: Test the Deployment

Get WebSocket URL:

```bash
WS_URL=$(aws cloudformation describe-stacks \
  --stack-name DrawvidVerseMatchmakerStack \
  --query 'Stacks[0].Outputs[?OutputKey==`WebSocketApiUrl`].OutputValue' \
  --output text)

echo $WS_URL
```

Run test client:

```bash
node tools/scripts/test-client.js $WS_URL
```

Expected output:
```
✓ Connected
→ Creating world...
← Received: { "t": "worldCreated", "worldId": "w_..." }
→ Joining world: w_...
← Received: { "t": "status", "msg": "STARTING" }
← Received: {
  "t": "joinResult",
  "worldId": "w_...",
  "endpoint": { "ip": "1.2.3.4", "port": 7777 },
  "token": "eyJ..."
}
✓ Successfully joined world!
```

## Step 7: Connect Your Game Client

Your game client should:

1. Connect to WebSocket API URL
2. Send `createWorld` or `joinWorld` message
3. Receive `joinResult` with world server endpoint and JWT token
4. Connect to world server WebSocket at `ws://<ip>:<port>`
5. Send `auth` message with token
6. Send `join` message
7. Start sending `in` (input) messages and receiving `s` (snapshot) messages

## Production Considerations

### Security

1. **JWT Secret**: The stack currently embeds the secret in Lambda env vars. For production:
   - Use Secrets Manager properly with rotation
   - Use asymmetric keys (RS256) instead of HS256

2. **API Gateway**: Add authentication/authorization
   - AWS IAM
   - Custom authorizers
   - API keys

3. **DynamoDB**: Enable point-in-time recovery and backups

4. **VPC**: Review security group rules

### Scaling

- **Lambda**: Adjust concurrency limits and timeouts
- **ECS**: Tune task size (CPU/memory) based on load testing
- **DynamoDB**: Monitor capacity and consider provisioned mode for predictable load

### Monitoring

Add CloudWatch alarms for:
- Lambda errors and throttles
- ECS task failures
- DynamoDB throttles
- API Gateway 4xx/5xx errors

### Costs

When idle (no players):
- API Gateway: $0 (no connections)
- Lambda: $0 (no invocations)
- ECS: $0 (no tasks running)
- DynamoDB: ~$0.25/month (PAY_PER_REQUEST with minimal storage)
- VPC: $0 (no NAT gateways)

Active costs scale with:
- ECS task hours ($0.04/hour per task)
- Lambda invocations
- DynamoDB read/write units
- Data transfer

## Cleanup

To delete all AWS resources:

```bash
cd packages/drawvid-matchmaker/infra
cdk destroy
```

Note: ECR repository must be empty before deletion. Delete images first:

```bash
aws ecr batch-delete-image \
  --repository-name drawvidverse-worldserver \
  --image-ids imageTag=latest
```
