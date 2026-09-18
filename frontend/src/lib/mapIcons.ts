/**
 * Leaflet marker factories.
 *
 * Markers are built as `divIcon`s holding inline SVG rather than image files:
 * they inherit the theme's colours, stay crisp at any zoom, and a vehicle's
 * heading can be applied as a CSS rotation without shipping 360 sprites.
 */

import L from 'leaflet';
import type { AmbulanceStatus } from '@sas/shared';
import { AMBULANCE_STATUS_COLOURS } from './format';

/** Leaflet ships broken default icon URLs under a bundler; ours replace them. */
export function ambulanceIcon(status: AmbulanceStatus, heading = 0, isFocused = false): L.DivIcon {
  const colour = AMBULANCE_STATUS_COLOURS[status];
  const size = isFocused ? 44 : 34;
  const responding = ['DISPATCHED', 'ON_SCENE', 'TRANSPORTING'].includes(status);

  return L.divIcon({
    className: 'marker-plain',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `
      <div style="position:relative;width:${size}px;height:${size}px;">
        ${
          responding
            ? `<span style="position:absolute;inset:0;border-radius:9999px;background:${colour};
                 opacity:0.28;animation:halo 2s cubic-bezier(0,0,0.2,1) infinite;"></span>`
            : ''
        }
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
                    border-radius:9999px;background:#11141c;border:2px solid ${colour};
                    box-shadow:0 4px 14px rgba(0,0,0,0.55);
                    transform:rotate(${heading}deg);transition:transform .4s ease-out;">
          <svg width="${size * 0.5}" height="${size * 0.5}" viewBox="0 0 24 24" fill="none"
               stroke="${colour}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3 L12 21" opacity="0.001"/>
            <path d="M12 2 L19 20 L12 16 L5 20 Z" fill="${colour}" stroke="${colour}"/>
          </svg>
        </div>
      </div>`,
  });
}

/** The patient's location: a red pin with a pulsing halo. */
export function patientIcon(): L.DivIcon {
  return L.divIcon({
    className: 'marker-plain',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    html: `
      <div style="position:relative;width:40px;height:40px;">
        <span style="position:absolute;inset:0;border-radius:9999px;background:#f43f5e;opacity:0.3;
                     animation:halo 2.4s cubic-bezier(0,0,0.2,1) infinite;"></span>
        <span style="position:absolute;inset:0;border-radius:9999px;background:#f43f5e;opacity:0.3;
                     animation:halo 2.4s cubic-bezier(0,0,0.2,1) 1.2s infinite;"></span>
        <div style="position:absolute;inset:8px;border-radius:9999px;background:#f43f5e;
                    border:2.5px solid #fff1f2;box-shadow:0 4px 16px rgba(244,63,94,0.6);"></div>
      </div>`,
  });
}

export function hospitalIcon(isDestination = false): L.DivIcon {
  const colour = isDestination ? '#2dd4bf' : '#8a92a6';
  const size = isDestination ? 34 : 26;

  return L.divIcon({
    className: 'marker-plain',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `
      <div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;
                  border-radius:9px;background:#11141c;border:2px solid ${colour};
                  box-shadow:0 3px 10px rgba(0,0,0,0.5);">
        <svg width="${size * 0.58}" height="${size * 0.58}" viewBox="0 0 24 24" fill="${colour}">
          <path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z"/>
        </svg>
      </div>`,
  });
}

/** Palette for route polylines, matched to the stage of the journey. */
export const ROUTE_COLOURS = {
  toScene: '#38bdf8',
  toHospital: '#2dd4bf',
} as const;
