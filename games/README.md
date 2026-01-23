# Game Configs

Each game in the drawvidverse ecosystem has its own configuration file.

## Format

`{gameKey}.config.json`

## Schema

All config files must follow this stable schema:

```json
{
  "gameKey": "string",
  "worldServer": {
    "port": "number",
    "tickHz": "number (simulation tick rate)",
    "snapshotHz": "number (network update rate)",
    "maxPlayers": "number",
    "cellSize": "number (spatial hash cell size)",
    "visRadius": "number (visibility/interest radius)",
    "voiceRadius": "number (proximity voice radius)",
    "emptyShutdownSeconds": "number (idle time before ECS self-stop)",
    "bootstrapMaxBytes": "number (max bootstrap payload size)"
  },
  "physics": {
    "gravity": "number",
    "jumpSpeed": "number",
    "moveSpeed": "number",
    "airControl": "number (0-1, air movement factor)",
    "playerCapsule": {
      "radius": "number",
      "height": "number"
    }
  },
  "world": {
    "bootstrapRequired": "boolean",
    "heightmapClamp": {
      "min": "number",
      "max": "number"
    },
    "maxInstancesTotal": "number",
    "maxAabbs": "number"
  },
  "security": {
    "jwtTtlSeconds": "number"
  },
  "aws": {
    "region": "string"
  }
}
```

## Adding a New Game

1. Create `games/yourgame.config.json`
2. Set unique `gameKey`
3. Tune parameters for your game's needs
4. Deploy matchmaker with your game key:
   ```bash
   pnpm deploy:matchmaker -- --game yourgame
   ```

Both the matchmaker and world server will automatically load this config at runtime.

## Current Games

- **cyberia**: First game, 3D open world with procedural terrain
