import WebSocket from 'ws';
import { sendMessage } from '../net/protocol';
import { logger } from '../app/logger';

export interface SignalingMessage {
  t: 'rtcOffer' | 'rtcAnswer' | 'rtcIce';
  to: string;
  sdp?: string;
  candidate?: string;
}

export class SignalingRelay {
  private voicePeers: Map<string, Set<string>>;
  private playerSockets: Map<string, WebSocket>;

  constructor() {
    this.voicePeers = new Map();
    this.playerSockets = new Map();
  }

  updateVoicePeers(voicePeers: Map<string, Set<string>>): void {
    this.voicePeers = voicePeers;

    // Notify all players of their current voice peers
    for (const [playerId, peers] of voicePeers) {
      const ws = this.playerSockets.get(playerId);
      if (ws) {
        sendMessage(ws, {
          t: 'voicePeers',
          peers: Array.from(peers),
        });
      }
    }
  }

  registerPlayer(playerId: string, ws: WebSocket): void {
    this.playerSockets.set(playerId, ws);
  }

  unregisterPlayer(playerId: string): void {
    this.playerSockets.delete(playerId);
    this.voicePeers.delete(playerId);
  }

  relaySignaling(fromId: string, message: SignalingMessage): void {
    const toId = message.to;

    // Check if these players are voice peers
    const peers = this.voicePeers.get(fromId);
    if (!peers || !peers.has(toId)) {
      logger.warn(
        { fromId, toId },
        'Signaling blocked: players not in voice proximity'
      );
      return;
    }

    const toSocket = this.playerSockets.get(toId);
    if (!toSocket) {
      logger.warn({ toId }, 'Signaling target not connected');
      return;
    }

    // Relay the message (add 'from' field)
    sendMessage(toSocket, {
      ...message,
      from: fromId,
    } as any);
  }
}
