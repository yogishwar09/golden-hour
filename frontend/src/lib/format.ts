/**
 * Presentation helpers.
 *
 * Wording matters in an emergency product: "2 min" is reassuring, "120s" is
 * not, and "--" is better than "NaN" when a value has not arrived yet.
 */

import type { AmbulanceStatus, Priority, RequestStatus } from '@sas/shared';

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '--';
  const minutes = Math.max(0, Math.round(seconds / 60));
  if (minutes < 1) return 'Arriving now';
  if (minutes === 1) return '1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '--';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  return new Date(iso).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "just now" / "4 min ago" / "2 h ago", for freshness indicators. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

export function formatDistance(metres: number | null | undefined): string {
  if (metres === null || metres === undefined || !Number.isFinite(metres)) return '--';
  if (metres < 950) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}

export function formatDurationShort(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '--';
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes === 0) return `${rest}s`;
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

/** Tailwind classes per priority, so urgency reads the same on every screen. */
export const PRIORITY_STYLES: Record<Priority, string> = {
  P1: 'bg-emergency-500/15 text-emergency-300 ring-1 ring-inset ring-emergency-500/40',
  P2: 'bg-orange-500/15 text-orange-300 ring-1 ring-inset ring-orange-500/40',
  P3: 'bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-500/40',
  P4: 'bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-500/40',
};

export const REQUEST_STATUS_STYLES: Record<RequestStatus, string> = {
  PENDING: 'bg-ink-700 text-ink-200',
  SEARCHING: 'bg-amber-500/15 text-amber-300',
  ASSIGNED: 'bg-sky-500/15 text-sky-300',
  EN_ROUTE_TO_SCENE: 'bg-sky-500/15 text-sky-300',
  ON_SCENE: 'bg-violet-500/15 text-violet-300',
  TRANSPORTING: 'bg-indigo-500/15 text-indigo-300',
  ARRIVED_AT_HOSPITAL: 'bg-teal-500/15 text-teal-300',
  COMPLETED: 'bg-emerald-500/15 text-emerald-300',
  CANCELLED: 'bg-ink-700 text-ink-300',
  NO_AMBULANCE_AVAILABLE: 'bg-emergency-600/20 text-emergency-300',
};

export const AMBULANCE_STATUS_STYLES: Record<AmbulanceStatus, string> = {
  OFFLINE: 'bg-ink-700 text-ink-300',
  AVAILABLE: 'bg-emerald-500/15 text-emerald-300',
  OFFERED: 'bg-amber-500/15 text-amber-300',
  DISPATCHED: 'bg-sky-500/15 text-sky-300',
  ON_SCENE: 'bg-violet-500/15 text-violet-300',
  TRANSPORTING: 'bg-indigo-500/15 text-indigo-300',
  AT_HOSPITAL: 'bg-teal-500/15 text-teal-300',
  OUT_OF_SERVICE: 'bg-emergency-600/20 text-emergency-300',
};

/** Map-pin fill per vehicle status; hex, because these go into SVG markers. */
export const AMBULANCE_STATUS_COLOURS: Record<AmbulanceStatus, string> = {
  OFFLINE: '#5b6478',
  AVAILABLE: '#10b981',
  OFFERED: '#f59e0b',
  DISPATCHED: '#38bdf8',
  ON_SCENE: '#a78bfa',
  TRANSPORTING: '#818cf8',
  AT_HOSPITAL: '#2dd4bf',
  OUT_OF_SERVICE: '#f43f5e',
};

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/[\s_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
