import { vec3Distance, Vec3 } from '../world/colliders';

export interface PlayerPosition {
  id: string;
  position: Vec3;
}

export function computeProximityPeers(
  players: PlayerPosition[],
  radius: number
): Map<string, Set<string>> {
  const peers = new Map<string, Set<string>>();

  for (const player of players) {
    peers.set(player.id, new Set());
  }

  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];

      const dist = vec3Distance(a.position, b.position);

      if (dist <= radius) {
        peers.get(a.id)!.add(b.id);
        peers.get(b.id)!.add(a.id);
      }
    }
  }

  return peers;
}
