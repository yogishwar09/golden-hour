import type { Role } from '@sas/shared';

/** Where each role lands after signing in. */
export function homeRouteFor(role: Role): string {
  switch (role) {
    case 'driver':
      return '/drive';
    case 'hospital':
      return '/hospital';
    case 'admin':
      return '/control';
    default:
      return '/sos';
  }
}
