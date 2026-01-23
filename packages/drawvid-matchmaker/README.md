# drawvid-matchmaker

AWS serverless lobby and ECS task launcher for drawvidverse worlds.

## Architecture

- **API Gateway WebSocket API**: Client connections
- **Lambda**: Message handlers for lobby operations
- **DynamoDB**: World state and connection tracking
- **ECS Fargate**: On-demand world server tasks
- **VPC**: Network for ECS tasks with public IPs

## Features

- Create/join/leave worlds
- Launch world server tasks on-demand
- Discover task public IP (no load balancer)
- Issue JWT tokens for world server authentication
- Concurrent start protection (conditional DynamoDB writes)

## Deployment

```bash
cd infra
cdk bootstrap  # First time only
cdk deploy
```

## Environment Variables (set by CDK)

- `TABLE_NAME` - DynamoDB table name
- `JWT_SECRET_ARN` - Secrets Manager ARN for JWT secret
- `ECS_CLUSTER_ARN` - ECS cluster ARN
- `TASK_DEFINITION_ARN` - Task definition ARN
- `SUBNETS` - Comma-separated subnet IDs
- `SECURITY_GROUP` - Security group ID
- `GAME_KEY` - Game configuration key

## API Protocol

### Client → Matchmaker

**createWorld**
```json
{ "t": "createWorld", "gameKey": "cyberia", "worldId": "optional" }
```

**joinWorld**
```json
{ "t": "joinWorld", "gameKey": "cyberia", "worldId": "abc123" }
```

**leaveWorld**
```json
{ "t": "leaveWorld" }
```

**ping**
```json
{ "t": "ping" }
```

### Matchmaker → Client

**worldCreated**
```json
{ "t": "worldCreated", "worldId": "abc123" }
```

**status**
```json
{ "t": "status", "msg": "STARTING" }
```

**joinResult**
```json
{
  "t": "joinResult",
  "worldId": "abc123",
  "endpoint": { "ip": "1.2.3.4", "port": 7777 },
  "token": "jwt..."
}
```

**err**
```json
{ "t": "err", "code": "ERROR_CODE", "msg": "Description" }
```

## DynamoDB Schema

**World Item**
- PK: `WORLD#{gameKey}#{worldId}`
- SK: `META`
- status: `STOPPED|STARTING|RUNNING|ERROR`
- taskArn, publicIp, port, timestamps, revision

**Connection Item**
- PK: `CONN#{connectionId}`
- SK: `META`
- worldKey, userId
