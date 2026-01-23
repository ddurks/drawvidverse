# drawvid-worldserver

Authoritative Node.js WebSocket server for real-time multiplayer worlds.

## Features

- Authoritative movement (input-based, not position-based)
- Fixed-tick simulation (20Hz default)
- Heightmap terrain collision
- Interest management via spatial hashing
- Proximity voice chat (WebRTC signaling relay)
- World bootstrapping (first player uploads procedural world data)
- ECS self-stop when empty (scale-to-zero)

## Environment Variables

### Required in ECS
- `GAME_KEY` - Game configuration key (e.g., "cyberia")
- `WORLD_ID` - Unique world identifier
- `JWT_SECRET` - Secret for JWT verification
- `DDB_TABLE` - DynamoDB table name for bootstrap storage
- `ECS_CLUSTER_ARN` - ECS cluster ARN (for self-stop)
- `ECS_TASK_ARN` - Task ARN (for self-stop)
- `AWS_REGION` - AWS region

### Optional
- `CONFIG_BUCKET` - S3 bucket for game configs (if not using embedded config)
- `WORLD_STORE_MODE` - `memory` for local dev, `dynamodb` for production (default: dynamodb)

## Local Development

```bash
# Run with in-memory storage
GAME_KEY=cyberia WORLD_ID=local WORLD_STORE_MODE=memory JWT_SECRET=dev-secret pnpm dev

# Or use the workspace script
pnpm dev:worldserver -- --game cyberia
```

## Protocol

See [src/net/messages.ts](src/net/messages.ts) for the complete protocol schema.

### Client → Server

- `auth` - Authenticate with JWT token
- `join` - Join the world
- `in` - Send input (movement, jump)
- `bootstrapUpload` - Upload world bootstrap data (first player only)
- `rtcOffer/rtcAnswer/rtcIce` - WebRTC signaling

### Server → Client

- `welcome` - Connection accepted
- `bootstrapRequired` - Server needs world bootstrap
- `bootstrapData` - Complete world bootstrap payload
- `s` - Snapshot (player states)
- `voicePeers` - Nearby players for voice chat
- `err` - Error message

## Architecture

```
src/
  app/          - Application core (server, config, logger)
  net/          - Network layer (WebSocket, protocol, messages)
  world/        - World simulation (physics, spatial, colliders, bootstrap)
  voice/        - Proximity voice and WebRTC signaling relay
  aws/          - AWS integrations (ECS self-stop)
```
