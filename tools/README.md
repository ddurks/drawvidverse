# Tools & Deployment Scripts

Helper scripts for building, deploying, and testing DrawVidVerse.

## Quick Start

```bash
# Deploy backend infrastructure
./tools/scripts/deploy-matchmaker.sh

# Build and push world server image
./tools/scripts/build-worldserver.sh 593615615124.dkr.ecr.us-east-2.amazonaws.com/drawvidverse-worldserver

# Deploy frontend
./tools/scripts/deploy-frontend.sh

# Test at https://cyberia.drawvid.com
```

## Deployment Scripts

### `deploy-frontend.sh`

Build and deploy the Cyberia frontend to S3 + CloudFront.

```bash
./tools/scripts/deploy-frontend.sh [--no-invalidate]
```

**What it does:**
1. Builds Vite app
2. Uploads assets to S3 with 1-hour cache
3. Uploads index.html with no cache (forces fresh)
4. Invalidates CloudFront distribution `E2CCOO5NN3Z8QV`

**Usage:**
```bash
# Standard deployment with cache invalidation
./tools/scripts/deploy-frontend.sh

# Deploy without invalidating (faster, changes may take 1-2 min)
./tools/scripts/deploy-frontend.sh --no-invalidate

# Access the app
open https://cyberia.drawvid.com
```

**Cache headers:**
- Assets (js, css): 1 hour cache
- index.html: No cache (always fetches fresh)
- CloudFront: 1-2 min to invalidate

### `deploy-matchmaker.sh`

Deploy the entire matchmaker backend CDK stack.

```bash
./tools/scripts/deploy-matchmaker.sh
```

**What it deploys:**
- 🗄️ **DynamoDB** - World and player state
- 🔌 **API Gateway WebSocket** - Matchmaker communication (`wss://matchmaker.drawvid.com/`)
- ⚡ **Lambda Functions:**
  - `connect` - Player joins matchmaker
  - `disconnect` - Player leaves
  - `message` - Route createWorld/joinWorld/etc
  - `default` - Unknown messages
  - `cleanup` - Auto-stop idle worlds (runs every 5 min)
- 🐳 **ECS Cluster** - Runs world server tasks
- 🔗 **Network Load Balancer** - Routes to world servers
- 🔐 **IAM + Security Groups**

**How it works:**
1. Player connects to `wss://matchmaker.drawvid.com/`
2. Sends `{t: "createWorld", gameKey: "cyberia"}`
3. Matchmaker creates world in DynamoDB + launches ECS task
4. Returns `wss://world.drawvid.com:443` endpoint
5. Player connects to world server
6. After 10+ min idle → Lambda cleanup stops task

**Testing:**
```bash
# Watch matchmaker logs
aws logs tail /aws/lambda/DrawvidVerseMatchmakerStack-MessageHandlerXXX --follow

# Check deployed worlds
aws dynamodb scan --table-name DrawvidVerseMatchmakerStack-XXX

# Check running tasks
aws ecs list-tasks --cluster drawvidverse-cluster --region us-east-2
```

### `build-worldserver.sh`

Build and push the world server Docker image to ECR.

```bash
./tools/scripts/build-worldserver.sh <ecr-repo-uri>
```

**What it does:**
1. Compiles TypeScript
2. Builds Docker image
3. Pushes to ECR (container registry)

**Usage:**
```bash
# Get ECR repo from deploy-matchmaker.sh output or:
ECR_REPO="593615615124.dkr.ecr.us-east-2.amazonaws.com/drawvidverse-worldserver"

./tools/scripts/build-worldserver.sh $ECR_REPO
```

The image is automatically used by ECS when launching tasks.

### `destroy-backend.sh`

Completely destroy the CDK stack and all AWS resources. **This is irreversible!**

```bash
./tools/scripts/destroy-backend.sh [--confirm]
```

**What gets deleted:**
- ❌ DynamoDB table (all world state)
- ❌ API Gateway + WebSocket API
- ❌ All Lambda functions
- ❌ ECS cluster + running tasks
- ❌ Network Load Balancer
- ❌ IAM roles and security groups

**Usage:**
```bash
# Interactive confirmation required
./tools/scripts/destroy-backend.sh

# Skip confirmation (be very careful!)
./tools/scripts/destroy-backend.sh --confirm

# Rebuild after destroying
./tools/scripts/deploy-matchmaker.sh
```

## Development Scripts

### `dev-worldserver.sh`

Run the world server locally for development.

```bash
./tools/scripts/dev-worldserver.sh [game-key] [world-id]
```

Example:
```bash
./tools/scripts/dev-worldserver.sh cyberia local
```

### `direct-connect.js`

Connect directly to a world server WebSocket (skip matchmaker).

```bash
node ./tools/scripts/direct-connect.js <world-server-url>
```

### `test-client.js`

Test the matchmaker WebSocket API end-to-end.

```bash
node tools/scripts/test-client.js <websocket-url>
```

Example:
```bash
node tools/scripts/test-client.js wss://abc123.execute-api.us-east-2.amazonaws.com/prod
```

This will:
1. Connect to the matchmaker
2. Create a world
3. Join the world
4. Display the world server endpoint and JWT token

## Deployment Flow

1. **Bootstrap CDK** (first time only):
   ```bash
   cd packages/drawvid-matchmaker/infra
   npx cdk bootstrap
   ```

2. **Deploy matchmaker**:
   ```bash
   ./tools/scripts/deploy-matchmaker.sh cyberia
   ```
   
   This creates:
   - WebSocket API
   - DynamoDB table
   - ECS cluster
   - Task definition
   - Lambda functions
   - VPC and networking

3. **Build and push world server image**:
   ```bash
   # Get ECR URI from CDK outputs
   ECR_URI=$(aws cloudformation describe-stacks \
     --stack-name DrawvidVerseMatchmakerStack \
     --query 'Stacks[0].Outputs[?OutputKey==`WorldserverRepoUri`].OutputValue' \
     --output text)
   
   ./tools/scripts/build-worldserver.sh $ECR_URI
   ```

4. **Test the system**:
   ```bash
   # Get WebSocket URL from CDK outputs
   WS_URL=$(aws cloudformation describe-stacks \
     --stack-name DrawvidVerseMatchmakerStack \
     --query 'Stacks[0].Outputs[?OutputKey==`WebSocketApiUrl`].OutputValue' \
     --output text)
   
   node tools/scripts/test-client.js $WS_URL
   ```

## Local Development

Run world server locally without AWS:

```bash
./tools/scripts/dev-worldserver.sh cyberia local
```

This uses in-memory storage and disables ECS self-stop.

## Troubleshooting

### Frontend changes aren't showing up?

```bash
# Option 1: Hard refresh in browser
# Mac: Cmd+Shift+R
# Windows: Ctrl+Shift+R

# Option 2: Open in Private/Incognito mode
# Firefox: Cmd+Shift+P
# Chrome: Cmd+Shift+N

# Option 3: Manually invalidate CloudFront
aws cloudfront create-invalidation \
  --distribution-id E2CCOO5NN3Z8QV \
  --paths "/*" \
  --region us-east-2

# Check invalidation status
aws cloudfront list-invalidations \
  --distribution-id E2CCOO5NN3Z8QV \
  --region us-east-2
```

### Backend won't deploy?

```bash
# Check TypeScript compilation errors
cd packages/drawvid-matchmaker
npm run build

# Check CDK synthesis
cd infra
npx cdk synth

# Try deploying with verbose output
npx cdk deploy --all --require-approval never -v

# Check CloudFormation events for error details
aws cloudformation describe-stack-events \
  --stack-name DrawvidVerseMatchmakerStack \
  --region us-east-2 | head -20
```

### Players can't connect?

```bash
# Check if matchmaker is accepting connections
aws logs tail /aws/lambda/ --follow --region us-east-2

# Check if world exists in DynamoDB
aws dynamodb scan \
  --table-name DrawvidVerseMatchmakerStack-WorldStateXXX \
  --region us-east-2

# Check if ECS task is running
aws ecs list-tasks \
  --cluster drawvidverse-cluster \
  --region us-east-2

# Check task logs
TASK_ARN=$(aws ecs list-tasks \
  --cluster drawvidverse-cluster \
  --region us-east-2 \
  --query 'taskArns[0]' --output text)

aws logs tail /ecs/drawvidverse-worldserver --follow --region us-east-2
```

### World server won't launch?

```bash
# Check ECR image exists
aws ecr list-images \
  --repository-name drawvidverse-worldserver \
  --region us-east-2

# Check task definition
aws ecs describe-task-definition \
  --task-definition drawvidverse-worldserver \
  --region us-east-2

# Check ECS cluster health
aws ecs describe-clusters \
  --clusters drawvidverse-cluster \
  --region us-east-2

# Check NLB target health
aws elbv2 describe-target-groups \
  --region us-east-2 | jq '.TargetGroups[] | select(.TargetGroupName | contains("drawvidverse"))'

# Get target group ARN and check health
TARGET_GROUP_ARN="arn:aws:elasticloadbalancing:us-east-2:593615615124:targetgroup/drawvidverse-XXX/XXX"
aws elbv2 describe-target-health \
  --target-group-arn $TARGET_GROUP_ARN \
  --region us-east-2
```

### DynamoDB table is full/corrupted?

```bash
# Scan the table
aws dynamodb scan \
  --table-name DrawvidVerseMatchmakerStack-WorldStateXXX \
  --region us-east-2

# Delete a specific world entry
aws dynamodb delete-item \
  --table-name DrawvidVerseMatchmakerStack-WorldStateXXX \
  --key '{"worldId": {"S": "world_cyberia_public"}}' \
  --region us-east-2

# Clear entire table (DANGEROUS!)
aws dynamodb delete-table \
  --table-name DrawvidVerseMatchmakerStack-WorldStateXXX \
  --region us-east-2
# Table will be recreated on next deploy
```

## AWS Resources Reference

- **Region:** us-east-2
- **Account ID:** 593615615124
- **Matchmaker WebSocket:** `wss://matchmaker.drawvid.com/`
- **World Server:** `wss://world.drawvid.com:443`
- **Frontend:** `https://cyberia.drawvid.com`
- **CloudFront Dist (frontend):** `E2CCOO5NN3Z8QV`
- **S3 Bucket (frontend):** `cyberia-drawvid-frontend-593615615124`

## Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| "Token not valid for this world" | Backend worldId mismatch. Check that backend uses `world_${gameKey}_public` |
| Second player creates new world | Backend should auto-select worldId, not use frontend-provided value |
| Frontend code won't update | Invalidate CloudFront E2CCOO5NN3Z8QV or hard refresh Cmd+Shift+R |
| ECS task won't start | Check ECR image exists and task def references correct image |
| Lambda timeout | Increase timeout in CDK stack (search for `timeout` in matchmaker-stack.ts) |
| High latency to world server | Check NLB health + ECS task CPU/memory allocation |
