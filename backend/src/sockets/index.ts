/**
 * The realtime layer.
 *
 * Sockets are authenticated with the same JWT as the REST API, verified once
 * during the handshake. Every connection is then placed in the rooms its role
 * entitles it to, which is what makes broadcasting safe: a patient's socket is
 * never in the control room, so a fleet-wide event cannot reach it.
 */

import { Server, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import {
  locationPingSchema,
  rooms,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@sas/shared';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { verifyAccessToken } from '../middleware/auth.js';
import { Ambulance, EmergencyRequest, User, type UserDocument } from '../models/index.js';
import { recordLocationPing } from '../services/tracking.service.js';
import { sameId } from '../utils/ids.js';
import { registerSocketServer, clearSocketServer, type AppServer } from '../services/realtime.service.js';

interface SocketData {
  user: UserDocument;
}

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/** Crew devices ping often; this caps how much one socket can send. */
const LOCATION_MIN_INTERVAL_MS = 900;
const lastLocationAt = new WeakMap<AppSocket, number>();

export function createSocketServer(httpServer: HttpServer): AppServer {
  const io: AppServer = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: env.corsOrigins, credentials: true },
    // Long enough to ride out a phone switching from wifi to mobile data
    // mid-incident without dropping the crew's session.
    pingTimeout: 25_000,
    pingInterval: 20_000,
    connectionStateRecovery: { maxDisconnectionDuration: 60_000 },
  });

  io.use(async (socket, next) => {
    try {
      const raw = socket.handshake.auth?.token ?? socket.handshake.headers.authorization;
      const token = typeof raw === 'string' ? raw.replace(/^Bearer\s+/i, '') : null;
      if (!token) return next(new Error('Authentication required'));

      const payload = verifyAccessToken(token);
      const user = await User.findById(payload.sub);
      if (!user?.isActive) return next(new Error('Account is not active'));

      (socket as AppSocket).data.user = user;
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    void onConnection(socket as AppSocket);
  });

  registerSocketServer(io);
  return io;
}

async function onConnection(socket: AppSocket): Promise<void> {
  const user = socket.data.user;
  const userId = user._id.toString();

  // Personal room: everything addressed to this human arrives here, across
  // however many devices they have open.
  await socket.join(rooms.user(userId));

  if (user.role === 'admin') {
    await socket.join(rooms.control);
  }
  if (user.role === 'hospital') {
    // Hospital staff see the live board, so they share the control-room feed.
    await socket.join(rooms.control);
  }
  if (user.role === 'driver') {
    const vehicle = await Ambulance.findOne({ driver: user._id });
    if (vehicle) await socket.join(rooms.ambulance(vehicle._id.toString()));
  }

  socket.emit('connection:ready', {
    userId,
    role: user.role,
    at: new Date().toISOString(),
  });

  logger.debug({ userId, role: user.role }, 'Socket connected');

  socket.on('driver:location', (payload) => {
    void handleLocation(socket, payload);
  });

  socket.on('request:subscribe', ({ requestId }) => {
    void subscribeToRequest(socket, requestId);
  });

  socket.on('request:unsubscribe', ({ requestId }) => {
    void socket.leave(rooms.request(requestId));
  });

  socket.on('fleet:subscribe', () => {
    void sendFleetSnapshot(socket);
  });

  socket.on('disconnect', (reason) => {
    logger.debug({ userId, reason }, 'Socket disconnected');
  });
}

async function handleLocation(
  socket: AppSocket,
  payload: unknown,
): Promise<void> {
  const user = socket.data.user;
  if (user.role !== 'driver') {
    socket.emit('server:error', { code: 'FORBIDDEN', message: 'Only crews report position' });
    return;
  }

  const now = Date.now();
  const previous = lastLocationAt.get(socket) ?? 0;
  if (now - previous < LOCATION_MIN_INTERVAL_MS) return; // Silently drop the excess.
  lastLocationAt.set(socket, now);

  const parsed = locationPingSchema.safeParse(payload);
  if (!parsed.success) {
    socket.emit('server:error', { code: 'BAD_PAYLOAD', message: 'Invalid location payload' });
    return;
  }

  try {
    await recordLocationPing(user._id.toString(), parsed.data);
  } catch (error) {
    logger.error({ err: error, userId: user._id.toString() }, 'Failed to record position');
  }
}

/**
 * Joining a case's room is an authorisation decision, not a subscription: it is
 * exactly the check the REST endpoint makes, because the room carries the same
 * patient details.
 */
async function subscribeToRequest(socket: AppSocket, requestId: string): Promise<void> {
  const user = socket.data.user;

  const request = await EmergencyRequest.findById(requestId);
  if (!request) {
    socket.emit('server:error', { code: 'NOT_FOUND', message: 'That case was not found' });
    return;
  }

  let allowed = user.role === 'admin' || user.role === 'hospital';
  if (!allowed && sameId(request.patient, user._id)) allowed = true;
  if (!allowed && user.role === 'driver') {
    const vehicle = await Ambulance.findOne({ driver: user._id });
    if (vehicle) {
      allowed =
        sameId(request.ambulance, vehicle._id) ||
        request.dispatchAttempts.some(
          (attempt) => sameId(attempt.ambulance, vehicle._id) && attempt.outcome === 'PENDING',
        );
    }
  }

  if (!allowed) {
    socket.emit('server:error', { code: 'FORBIDDEN', message: 'You cannot follow that case' });
    return;
  }

  await socket.join(rooms.request(requestId));
}

/** The current fleet picture, so a control-room map is populated on load. */
async function sendFleetSnapshot(socket: AppSocket): Promise<void> {
  const user = socket.data.user;
  if (user.role !== 'admin' && user.role !== 'hospital') {
    socket.emit('server:error', { code: 'FORBIDDEN', message: 'Fleet view is restricted' });
    return;
  }

  const vehicles = await Ambulance.find({ isActive: true })
    .populate('driver', 'name phone')
    .populate('hospital', 'name');
  socket.emit('fleet:snapshot', vehicles.map((vehicle) => vehicle.toDto()));
}

export async function closeSocketServer(io: AppServer): Promise<void> {
  clearSocketServer();
  await new Promise<void>((resolve) => io.close(() => resolve()));
}
