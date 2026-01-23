import WebSocket from 'ws';
import { ServerMessage } from './messages';

export function sendMessage(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

export function sendError(ws: WebSocket, code: string, msg: string): void {
  sendMessage(ws, { t: 'err', code, msg });
}
