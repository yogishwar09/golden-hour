import { useCallback, useEffect, useRef, useState } from 'react';
import type { LatLng } from '@sas/shared';

interface GeolocationState {
  position: LatLng | null;
  accuracy: number | null;
  error: string | null;
  loading: boolean;
  /** True once the browser has given a fix at least once. */
  ready: boolean;
}

/** Plain-language versions of the browser's numeric error codes. */
function describe(error: GeolocationPositionError): string {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      // Deliberately role-neutral: this hook serves both the caller raising an
      // emergency and the crew streaming their position.
      return 'Location access was denied. Enable it in your browser settings and reload.';
    case error.POSITION_UNAVAILABLE:
      return 'Your location is unavailable right now. Try moving somewhere with a clearer signal.';
    case error.TIMEOUT:
      return 'Finding your location is taking longer than expected.';
    default:
      return 'Could not determine your location.';
  }
}

/**
 * Watches the device's position.
 *
 * `watch` mode is used for crews, whose position must stream continuously; a
 * one-shot read is enough for a caller pressing SOS.
 */
export function useGeolocation({ watch = false } = {}): GeolocationState & {
  refresh: () => void;
} {
  const [state, setState] = useState<GeolocationState>({
    position: null,
    accuracy: null,
    error: null,
    loading: true,
    ready: false,
  });
  const watchId = useRef<number | null>(null);

  const apply = useCallback((fix: GeolocationPosition) => {
    setState({
      position: { lat: fix.coords.latitude, lng: fix.coords.longitude },
      accuracy: fix.coords.accuracy,
      error: null,
      loading: false,
      ready: true,
    });
  }, []);

  const fail = useCallback((error: GeolocationPositionError) => {
    setState((previous) => ({
      ...previous,
      // Keep the last good fix: a momentary timeout should not blank the map.
      error: describe(error),
      loading: false,
    }));
  }, []);

  const refresh = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setState((previous) => ({
        ...previous,
        error: 'This browser cannot provide your location.',
        loading: false,
      }));
      return;
    }
    setState((previous) => ({ ...previous, loading: true }));
    navigator.geolocation.getCurrentPosition(apply, fail, {
      enableHighAccuracy: true,
      timeout: 12_000,
      maximumAge: 5_000,
    });
  }, [apply, fail]);

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setState({
        position: null,
        accuracy: null,
        error: 'This browser cannot provide your location.',
        loading: false,
        ready: false,
      });
      return;
    }

    if (watch) {
      watchId.current = navigator.geolocation.watchPosition(apply, fail, {
        enableHighAccuracy: true,
        timeout: 20_000,
        maximumAge: 2_000,
      });
      return () => {
        if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
      };
    }

    refresh();
    return undefined;
  }, [watch, apply, fail, refresh]);

  return { ...state, refresh };
}
