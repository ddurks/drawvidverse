# drawvidverse

Reusable, scale-to-zero multiplayer backend monorepo for multiple 3D games.

## Architecture

- **drawvid-matchmaker**: AWS serverless lobby (API Gateway WebSocket + Lambda + DynamoDB) that launches ECS tasks
- **drawvid-worldserver**: Node.js authoritative WebSocket server (runs on ECS Fargate)
- **Game configs**: Per-game configuration files (`games/*.config.json`)

## Features

- $0 compute when nobody connected (scale-to-zero via ECS task self-stop)
- Up to 30 players per world
- WebSockets for realtime communication
- Authoritative movement, jumping, and simple collision
- Interest management and proximity voice chat (WebRTC signaling relay)
- World bootstrapping: first player uploads procedural terrain/trees; server persists and serves to later players

## Quick Start

### Install dependencies

```bash
pnpm install
```

### Build all packages

```bash
pnpm build
```

### Local development (world server)

```bash
pnpm dev:worldserver -- --game cyberia
```

### Deploy matchmaker to AWS

```bash
pnpm deploy:matchmaker -- --game cyberia
```

## Project Structure

```
drawvidverse/
├── packages/
│   ├── drawvid-worldserver/    # Authoritative game server
│   └── drawvid-matchmaker/     # AWS serverless lobby
├── games/                      # Per-game configuration
│   └── cyberia.config.json
└── tools/                      # Helper scripts
```

## How it works

1. Client connects to matchmaker WebSocket API
2. Client creates/joins a world
3. Matchmaker launches ECS Fargate task for that world (if not running)
4. Matchmaker discovers task public IP and returns endpoint + JWT token
5. Client connects to world server, authenticates, and plays
6. When world is empty for N seconds, world server stops its own ECS task

## Adding a new game

1. Create `games/yourgame.config.json` (see `cyberia.config.json` for schema)
2. Deploy: `pnpm deploy:matchmaker -- --game yourgame`
3. World server automatically loads config at runtime
