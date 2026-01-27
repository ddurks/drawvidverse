# drawvidverse

Reusable, scale-to-zero multiplayer backend monorepo for multiple 3D games.

## Quick Links

- 🚀 **Deployment**: See [GITHUB_ACTIONS_SETUP.md](GITHUB_ACTIONS_SETUP.md) for automated CI/CD
- 📖 **Scripts**: See [tools/README.md](tools/README.md) for manual deployment
- 🔧 **Architecture**: See below

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
- **Automated deployment** via GitHub Actions on merge to main

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

### Manual deployment (see GITHUB_ACTIONS_SETUP.md for automated)

```bash
# Deploy matchmaker backend
./tools/scripts/deploy-matchmaker.sh

# Build and push world server image
./tools/scripts/build-worldserver.sh 593615615124.dkr.ecr.us-east-2.amazonaws.com/drawvidverse-worldserver

# Deploy frontend
./tools/scripts/deploy-frontend.sh
```

## Automated Deployment (GitHub Actions)

The repository is configured with GitHub Actions to automatically deploy on merge to `main`:

1. **Setup**: Follow [GITHUB_ACTIONS_SETUP.md](GITHUB_ACTIONS_SETUP.md)
2. **Push changes** to `main` branch
3. **Automatic detection**: Workflow detects which components changed
4. **Parallel deployment**: Only changed components are deployed
5. **Production live**: In 2-5 minutes depending on component

### What triggers deployment?

- **Frontend changes**: Any change in `cyberia/` → Deploy frontend to S3/CloudFront
- **World Server changes**: Any change in `packages/drawvid-worldserver/` or `games/` → Build & push ECR image
- **Matchmaker changes**: Any change in `packages/drawvid-matchmaker/` or `games/` → Deploy CDK stack

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
