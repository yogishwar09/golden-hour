/**
 * The realtime contract.
 *
 * Both sides import these maps and pass them to Socket.IO's generics, so a
 * typo in an event name or a changed payload is a compile error rather than a
 * silent no-op at 3am.
 */

import type { AmbulanceStatus, RequestStatus } from './enums.js';
import type { AmbulanceDto, DispatchOfferDto, EmergencyRequestDto, RouteDto } from './dto.js';
import type { LatLng } from './geo.js';

/** Room naming, shared so the server and its tests agree on the strings. */
export const rooms = {
  user: (userId: string) => `user:${userId}`,
  request: (requestId: string) => `request:${requestId}`,
  ambulance: (ambulanceId: string) => `ambulance:${ambulanceId}`,
  hospital: (hospitalId: string) => `hospital:${hospitalId}`,
  /** Every admin and control-room screen. */
  control: 'control-room',
} as const;

export interface AmbulancePositionEvent {
  ambulanceId: string;
  vehicleNumber: string;
  status: AmbulanceStatus;
  location: LatLng;
  heading: number;
  speedMps: number;
  at: string;
  /** Set when the vehicle is currently committed to a case. */
  requestId?: string | null;
}

export interface EtaEvent {
  requestId: string;
  etaSeconds: number;
  distanceMetres: number;
  route?: RouteDto | null;
  at: string;
}

export interface StatusEvent {
  requestId: string;
  status: RequestStatus;
  at: string;
  note?: string;
}

export interface NotificationEvent {
  id: string;
  level: 'info' | 'success' | 'warning' | 'critical';
  title: string;
  body?: string;
  requestId?: string;
  at: string;
}

/** Events the server pushes to clients. */
export interface ServerToClientEvents {
  'connection:ready': (payload: { userId: string; role: string; at: string }) => void;
  'request:created': (payload: EmergencyRequestDto) => void;
  'request:updated': (payload: EmergencyRequestDto) => void;
  'request:status': (payload: StatusEvent) => void;
  'request:eta': (payload: EtaEvent) => void;
  'dispatch:offer': (payload: DispatchOfferDto) => void;
  /** The offer window closed or the case went elsewhere; clear the prompt. */
  'dispatch:offer_revoked': (payload: { requestId: string; reason: string }) => void;
  'ambulance:position': (payload: AmbulancePositionEvent) => void;
  'ambulance:status': (payload: { ambulanceId: string; status: AmbulanceStatus; at: string }) => void;
  'fleet:snapshot': (payload: AmbulanceDto[]) => void;
  notification: (payload: NotificationEvent) => void;
  'server:error': (payload: { code: string; message: string }) => void;
}

/** Events clients send to the server. */
export interface ClientToServerEvents {
  /** Drivers stream position here; the payload is validated server-side. */
  'driver:location': (payload: {
    lat: number;
    lng: number;
    heading?: number;
    speed?: number;
    accuracy?: number;
  }) => void;
  /** Follow a case to receive its updates without polling. */
  'request:subscribe': (payload: { requestId: string }) => void;
  'request:unsubscribe': (payload: { requestId: string }) => void;
  /** Control-room screens ask for the current fleet picture on connect. */
  'fleet:subscribe': () => void;
}

export interface SocketAuthPayload {
  token: string;
}
