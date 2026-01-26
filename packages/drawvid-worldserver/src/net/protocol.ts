import WebSocket from 'ws';
import { ServerMessage } from './messages';
import { logger } from '../app/logger';

export function sendMessage(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    const msgStr = JSON.stringify(message);
    if (message.t === 'welcome') {
      logger.info({ messageType: message.t, readyState: ws.readyState }, 'Sending welcome message to client');
    }
    ws.send(msgStr);
  } else {
    logger.warn({ messageType: message.t, readyState: ws.readyState }, 'Cannot send message - WebSocket not OPEN');
  }
}

export function sendError(ws: WebSocket, code: string, msg: string): void {
  sendMessage(ws, { t: 'err', code, msg });
}
