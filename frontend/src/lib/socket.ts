/**
 * The realtime client.
 *
 * One shared connection for the whole app: several screens subscribe to the
 * same events, and opening a socket per component would multiply the server's
 * connection count for no benefit.
 */

import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@sas/shared';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const SOCKET_URL = import.meta.env.VITE_API_URL ?? '';

let socket: AppSocket | null = null;
let currentToken: string | null = null;

/**
 * Returns the shared socket, connecting it if needed. Passing a different token
 * (a new sign-in) tears the old connection down first, so a socket is never
 * left authenticated as the previous user.
 */
export function connectSocket(token: string): AppSocket {
  if (socket && currentToken === token) return socket;
  if (socket) disconnectSocket();

  currentToken = token;
  socket = io(SOCKET_URL, {
    auth: { token },
    // Skips the HTTP long-polling handshake: both the dev proxy and the
    // deployment terminate WebSockets, so the upgrade dance is wasted time.
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 800,
    reconnectionDelayMax: 6000,
  }) as AppSocket;

  return socket;
}

export function getSocket(): AppSocket | null {
  return socket;
}

export function disconnectSocket(): void {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  currentToken = null;
}
