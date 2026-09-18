/**
 * A thin registry holding the Socket.IO server, so that any service can push an
 * event without importing the socket layer directly.
 *
 * Without this indirection the dispatcher would import the socket module and
 * the socket module would import the dispatcher, which is a cycle. Here the
 * dependency points one way: sockets register the server, services emit into it.
 *
 * Every helper is a no-op before registration, which is what makes unit tests
 * that never start a server work unchanged.
 */

import type { Server } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  AmbulancePositionEvent,
  EtaEvent,
  NotificationEvent,
  StatusEvent,
  DispatchOfferDto,
  EmergencyRequestDto,
  AmbulanceStatus,
} from '@sas/shared';
import { rooms } from '@sas/shared';

export type AppServer = Server<ClientToServerEvents, ServerToClientEvents>;

let io: AppServer | null = null;

export function registerSocketServer(server: AppServer): void {
  io = server;
}

export function getSocketServer(): AppServer | null {
  return io;
}

export function clearSocketServer(): void {
  io = null;
}

/**
 * Two helpers below forward a dynamically chosen event name, which the typed
 * emitter cannot express. They go through this narrow escape hatch rather than
 * loosening the generics on every other (fully typed) helper.
 */
type LooseEmitter = { emit: (event: string, payload: unknown) => void };

function emitLoosely(room: string, event: string, payload: unknown): void {
  (io?.to(room) as unknown as LooseEmitter | undefined)?.emit(event, payload);
}

export const realtime = {
  toUser(userId: string, event: keyof ServerToClientEvents, payload: unknown): void {
    emitLoosely(rooms.user(userId), event, payload);
  },

  requestUpdated(request: EmergencyRequestDto): void {
    if (!io) return;
    io.to(rooms.request(request.id)).emit('request:updated', request);
    io.to(rooms.user(request.patient.id)).emit('request:updated', request);
    io.to(rooms.control).emit('request:updated', request);
  },

  requestCreated(request: EmergencyRequestDto): void {
    if (!io) return;
    io.to(rooms.user(request.patient.id)).emit('request:created', request);
    io.to(rooms.control).emit('request:created', request);
  },

  requestStatus(event: StatusEvent, patientId?: string): void {
    if (!io) return;
    io.to(rooms.request(event.requestId)).emit('request:status', event);
    io.to(rooms.control).emit('request:status', event);
    if (patientId) io.to(rooms.user(patientId)).emit('request:status', event);
  },

  eta(event: EtaEvent, patientId?: string): void {
    if (!io) return;
    io.to(rooms.request(event.requestId)).emit('request:eta', event);
    if (patientId) io.to(rooms.user(patientId)).emit('request:eta', event);
  },

  offer(driverUserId: string, offer: DispatchOfferDto): void {
    io?.to(rooms.user(driverUserId)).emit('dispatch:offer', offer);
  },

  revokeOffer(driverUserId: string, requestId: string, reason: string): void {
    io?.to(rooms.user(driverUserId)).emit('dispatch:offer_revoked', { requestId, reason });
  },

  ambulancePosition(event: AmbulancePositionEvent): void {
    if (!io) return;
    io.to(rooms.control).emit('ambulance:position', event);
    io.to(rooms.ambulance(event.ambulanceId)).emit('ambulance:position', event);
    if (event.requestId) io.to(rooms.request(event.requestId)).emit('ambulance:position', event);
  },

  ambulanceStatus(ambulanceId: string, status: AmbulanceStatus): void {
    io?.to(rooms.control).emit('ambulance:status', {
      ambulanceId,
      status,
      at: new Date().toISOString(),
    });
  },

  notify(userId: string, notification: NotificationEvent): void {
    io?.to(rooms.user(userId)).emit('notification', notification);
  },

  toHospital(hospitalId: string, event: keyof ServerToClientEvents, payload: unknown): void {
    emitLoosely(rooms.hospital(hospitalId), event, payload);
  },
};
