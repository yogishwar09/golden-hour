/**
 * Pure-function tests: the triage table, the geometry helpers, and the
 * polyline decoder. No database, no network.
 */

import { describe, expect, it } from 'vitest';
import { haversineMetres, bearingDegrees, triage, vehicleMeets, escalate } from '@sas/shared';
import { decodePolyline, straightLineRoute, applyEmergencyFactor } from '../src/services/routing.service.js';

describe('triage', () => {
  it('treats a cardiac call as immediate and sends an advanced vehicle', () => {
    const result = triage('CARDIAC');
    expect(result.priority).toBe('P1');
    expect(result.minimumAmbulanceType).toBe('ALS');
  });

  it('escalates a non-urgent call when the patient is not breathing', () => {
    const baseline = triage('PSYCHIATRIC');
    expect(baseline.priority).toBe('P3');

    const escalated = triage('PSYCHIATRIC', { breathing: false });
    expect(escalated.priority).toBe('P1');
    expect(escalated.minimumAmbulanceType).toBe('MICU');
    expect(escalated.reasons.join(' ')).toContain('not breathing');
  });

  it('requires a neonatal vehicle for an infant', () => {
    const result = triage('PAEDIATRIC', { patientAgeYears: 0 });
    expect(result.minimumAmbulanceType).toBe('NEONATAL');
    expect(result.priority).toBe('P1');
  });

  it('raises priority for a mass-casualty incident', () => {
    expect(triage('TRAUMA', { victimCount: 6 }).priority).toBe('P1');
  });

  it('never downgrades an already-urgent priority', () => {
    expect(escalate('P1', 'P4')).toBe('P1');
    expect(escalate('P4', 'P2')).toBe('P2');
  });
});

describe('vehicle capability matching', () => {
  it('accepts an equal or more capable vehicle', () => {
    expect(vehicleMeets('ALS', 'BLS')).toBe(true);
    expect(vehicleMeets('ALS', 'ALS')).toBe(true);
    expect(vehicleMeets('MICU', 'ALS')).toBe(true);
  });

  it('rejects a vehicle below the required tier', () => {
    expect(vehicleMeets('BLS', 'ALS')).toBe(false);
    expect(vehicleMeets('PTV', 'BLS')).toBe(false);
  });
});

describe('geometry', () => {
  it('measures a known distance accurately', () => {
    // Bengaluru city centre to Indiranagar, roughly 5 km apart.
    const metres = haversineMetres({ lat: 12.9716, lng: 77.5946 }, { lat: 12.9784, lng: 77.6408 });
    expect(metres).toBeGreaterThan(4800);
    expect(metres).toBeLessThan(5400);
  });

  it('returns zero for a point measured against itself', () => {
    expect(haversineMetres(CENTRE_POINT, CENTRE_POINT)).toBeCloseTo(0, 6);
  });

  it('reports bearings in the 0-360 range', () => {
    expect(bearingDegrees({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(0, 1);
    expect(bearingDegrees({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(90, 1);
    const westward = bearingDegrees({ lat: 0, lng: 0 }, { lat: 0, lng: -1 });
    expect(westward).toBeGreaterThanOrEqual(0);
    expect(westward).toBeCloseTo(270, 1);
  });
});

const CENTRE_POINT = { lat: 12.9716, lng: 77.5946 };

describe('routing fallback', () => {
  it('decodes a known polyline', () => {
    // The canonical example from Google's polyline specification.
    const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(points).toHaveLength(3);
    expect(points[0]?.lat).toBeCloseTo(38.5, 4);
    expect(points[0]?.lng).toBeCloseTo(-120.2, 4);
    expect(points[2]?.lat).toBeCloseTo(43.252, 3);
  });

  it('produces a usable estimate without a routing server', () => {
    const route = straightLineRoute({ lat: 12.97, lng: 77.59 }, { lat: 12.99, lng: 77.62 });
    expect(route.source).toBe('straight-line');
    expect(route.distanceMetres).toBeGreaterThan(0);
    expect(route.durationSeconds).toBeGreaterThan(0);
    // The detour factor means road distance always exceeds the direct line.
    expect(route.distanceMetres).toBeGreaterThan(
      haversineMetres({ lat: 12.97, lng: 77.59 }, { lat: 12.99, lng: 77.62 }),
    );
  });

  it('shortens an ETA for an emergency vehicle but keeps a floor', () => {
    expect(applyEmergencyFactor(600)).toBeLessThan(600);
    expect(applyEmergencyFactor(1)).toBeGreaterThanOrEqual(30);
  });
});
