# Tools

Helper scripts for building, deploying, and testing drawvidverse.

## Scripts

### `build-worldserver.sh`

Build and push the world server Docker image to ECR.

```bash
./tools/scripts/build-worldserver.sh <ecr-repo-uri>
```

Example:
```bash
./tools/scripts/build-worldserver.sh 123456789012.dkr.ecr.us-east-2.amazonaws.com/drawvidverse-worldserver
```

### `deploy-matchmaker.sh`

Deploy the matchmaker CDK stack to AWS.

```bash
./tools/scripts/deploy-matchmaker.sh [game-key]
```

Example:
```bash
./tools/scripts/deploy-matchmaker.sh cyberia
```

### `dev-worldserver.sh`

Run the world server locally for development.

```bash
./tools/scripts/dev-worldserver.sh [game-key] [world-id]
```

Example:
```bash
./tools/scripts/dev-worldserver.sh cyberia local
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
