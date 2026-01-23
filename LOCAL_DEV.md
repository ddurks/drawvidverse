# Local Development Guide

Guide for developing and testing drawvidverse locally.

## Quick Start: Complete Local Environment

Run both world server AND local matchmaker together:

```bash
# Starts both services automatically
pnpm dev:full
```

This starts:
- **World server** on `ws://localhost:7777`
- **Local matchmaker** on `ws://localhost:8080`

Connect your client to `ws://localhost:8080` just like you would in production!

Test it:
```bash
node tools/scripts/test-client.js ws://localhost:8080
```

## Option 1: World Server Only (Direct Connection)

Run just the world server and connect directly (bypassing matchmaker):

```bash
./tools/scripts/dev-worldserver.sh cyberia local
# Or: pnpm dev:worldserver
```

Test direct connection:
```bash
node tools/scripts/direct-connect.js
**Easy way** - Use the test scripts:

```bash
# Test via local matchmaker (full flow)
pnpm dev:full
# In another terminal:
node tools/scripts/test-client.js ws://localhost:8080

# Test direct connection to world server
pnpm dev:worldserver
# In another terminal:
node tools/scripts/direct-connect.js
```

**Manual way** - Using `wscat`:

1. Start world server:
   ```bash
   pnpm dev:worldserver
   ```

2. Generate a JWT token:
   ```bash
   node -e "
   const jwt = require('jsonwebtoken');
   const token = jwt.sign(
     { sub: 'test-user', worldId: 'local', gameKey: 'cyberia' },
     'dev-local-secret-change-in-production',
     { expiresIn: '15m' }
   );
   console.log(token);
   "
   ```

3. Connect with WebSocket client
- No AWS dependencies

## Option 3: Full Local Environment (Recommended)

Best for full-stack development:

```bash
./tools/scripts/local-full.sh cyberia
```

This single command starts both services with proper coordination.

This starts the world server on port 7777 with:
- In-memory world storage (no DynamoDB)
- ECS self-stop disabled
- JWT secret: `dev-local-secret-change-in-production`

### Environment Variables

Required:
- `GAME_KEY` - Game config key (e.g., "cyberia")
- `WORLD_ID` - World identifier (e.g., "local")
- `JWT_SECRET` - Secret for JWT verification

Optional:
- `WORLD_STORE_MODE` - `memory` or `dynamodb` (default: dynamodb)
- `LOG_LEVEL` - `debug`, `info`, `warn`, `error` (default: info)

### Testing World Server Locally

1. Start world server:
   ```bash
   pnpm dev:worldserver
   ```

2. In another terminal, generate a test JWT:
   ```bash
   node -e "
   const jwt = require('jsonwebtoken');
   const token = jwt.sign(
     { sub: 'test-user', worldId: 'local', gameKey: 'cyberia' },
     'dev-local-secret-change-in-production',
     { expiresIn: '15m' }
   );
   console.log(token);
   "
   ```

3. Connect with a WebSocket client (e.g., `wscat`):
   ```bash
   npm install -g wscat
   wscat -c ws://localhost:7777
   ```

4. Send messages:
   ```json
   {"t":"auth","token":"<jwt-from-step-2>"}
   {"t":"join","name":"TestPlayer"}
   {"t":"in","seq":1,"mx":0.5,"mz":0,"yaw":0,"jump":false}
   {"t":"ping"}
   ```

5. You should receive:
   ```json
   {"t":"welcome","playerId":"p_...","tickRate":20}
   {"t":"bootstrapRequired"}
   {"t":"s","tick":123,"you":{...},"p":[]}
   {"t":"pong"}
   ```

## Matchmaker Local Development

The matchmaker is tightly coupled to AWS services (API Gateway, ECS, DynamoDB) and is best tested in AWS. However, you can:

1. Build Lambda functions locally:
   ```bash
   cd packages/drawvid-matchmaker
   pnpm build
   ```

2. Run unit tests (if implemented):
   ```bash
   pnpm test
   ```

3. Use SAM CLI for local Lambda testing:
   ```bash
   sam local start-api
   ```

## Testing Bootstrap Upload

To test world bootstrap functionality locally:

1. Start world server (will request bootstrap from first player)

2. Connect and authenticate

3. Upload bootstrap:
   ```json
   {
     "t": "bootstrapUpload",
     "worldId": "local",
     "version": 1,
     "payload": {
       "seed": 12345,
       "heightmap": {
         "width": 64,
         "depth": 64,
         "cellSize": 1.0,
         "origin": { "x": -32, "z": -32 },
         "heights": [... 4096 floats ...]
       },
       "instances": [
         {
           "kind": "tree",
           "positions": [
             { "x": 10, "y": 5, "z": 10, "yaw": 0, "scale": 1.5 }
           ]
         }
       ],
       "colliders": {
         "aabbs": [
           {
             "min": { "x": 9, "y": 4, "z": 9 },
             "max": { "x": 11, "y": 8, "z": 11 }
           }
         ]
       }
     }
   }
   ```

4. Server will validate, store (in memory), and broadcast to all connected players

## Hot Reload

Both packages support TypeScript compilation watch mode:

```bash
# World server
cd packages/drawvid-worldserver
pnpm build --watch

# In another terminal
pnpm dev
```

```bash
# Matchmaker
cd packages/drawvid-matchmaker
pnpm build --watch
```

## Debugging

### VS Code Launch Configuration

Add to `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "World Server",
      "runtimeArgs": ["-r", "ts-node/register"],
      "args": ["${workspaceFolder}/packages/drawvid-worldserver/src/index.ts"],
      "env": {
        "GAME_KEY": "cyberia",
        "WORLD_ID": "local",
        "WORLD_STORE_MODE": "memory",
        "JWT_SECRET": "dev-local-secret-change-in-production"
      },
      "cwd": "${workspaceFolder}/packages/drawvid-worldserver",
      "console": "integratedTerminal"
    }
  ]
}
```

### Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
LOG_LEVEL=debug pnpm dev:worldserver
```

## Common Issues

### "Failed to load game config"

- Ensure you're running from the correct directory
- Game config files are at `../../games/` relative to package root
- Check that `cyberia.config.json` exists

### "Missing required env vars"

- Set `GAME_KEY`, `WORLD_ID`, `JWT_SECRET`
- Use the dev scripts which set these automatically

### Port already in use

World server uses port 7777 by default. Change in game config or kill existing process:

```bash
lsof -ti:7777 | xargs kill
```
