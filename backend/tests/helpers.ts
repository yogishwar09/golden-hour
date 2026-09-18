/**
 * Shared test harness.
 *
 * Every suite runs against a real MongoDB (in memory), not a mocked one:
 * the dispatcher's correctness lives in geospatial queries and conditional
 * updates, and a mock would happily return whatever the test expected while
 * hiding a broken `$nearSphere` or a non-atomic claim.
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { configureMongoose } from '../src/config/db.js';
import {
  Ambulance,
  AuditLog,
  EmergencyRequest,
  Hospital,
  Notification,
  User,
  hashPassword,
  type AmbulanceDocument,
  type HospitalDocument,
  type UserDocument,
} from '../src/models/index.js';
import { clearAllOfferTimers } from '../src/services/dispatch.service.js';
import { resetRouteCache } from '../src/services/routing.service.js';
import { resetTrackingState } from '../src/services/tracking.service.js';
import type { AmbulanceType } from '@sas/shared';

let memoryServer: MongoMemoryServer | null = null;

export const TEST_PASSWORD = 'Password123';
/** A fixed point in Hyderabad, so distances in assertions are predictable. */
export const CENTRE = { lat: 17.385, lng: 78.4867 };

export async function startTestDatabase(): Promise<void> {
  // The same Mongoose configuration the server applies, so a setting that
  // changes query behaviour is exercised by the suite rather than discovered
  // in production.
  configureMongoose();
  memoryServer = await MongoMemoryServer.create();
  await mongoose.connect(memoryServer.getUri(), { dbName: 'sas_test' });
  await mongoose.connection.syncIndexes({ continueOnError: true });
}

export async function stopTestDatabase(): Promise<void> {
  clearAllOfferTimers();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await memoryServer?.stop();
  memoryServer = null;
}

export async function resetTestData(): Promise<void> {
  clearAllOfferTimers();
  resetRouteCache();
  resetTrackingState();
  await Promise.all([
    User.deleteMany({}),
    Hospital.deleteMany({}),
    Ambulance.deleteMany({}),
    EmergencyRequest.deleteMany({}),
    Notification.deleteMany({}),
    AuditLog.deleteMany({}),
  ]);
}

export function testApp(): Express {
  return createApp();
}

/** Moves a point by a number of metres north and east. */
export function offset(from: { lat: number; lng: number }, metresNorth: number, metresEast: number) {
  const degreesPerMetre = 1 / 111_320;
  return {
    lat: from.lat + metresNorth * degreesPerMetre,
    lng: from.lng + (metresEast * degreesPerMetre) / Math.cos((from.lat * Math.PI) / 180),
  };
}

export async function createUser(overrides: {
  email: string;
  role?: 'patient' | 'driver' | 'hospital' | 'admin';
  name?: string;
  phone?: string;
}): Promise<UserDocument> {
  return User.create({
    name: overrides.name ?? 'Test User',
    email: overrides.email,
    phone: overrides.phone ?? '+919800000000',
    passwordHash: await hashPassword(TEST_PASSWORD),
    role: overrides.role ?? 'patient',
    bloodGroup: 'O+',
  });
}

export async function createHospital(
  point = offset(CENTRE, 1500, 0),
  overrides: Partial<{ name: string; beds: number; traumaLevel: number }> = {},
): Promise<HospitalDocument> {
  return Hospital.create({
    name: overrides.name ?? 'Test Hospital',
    address: 'Test Road',
    phone: '+918000000000',
    location: { type: 'Point', coordinates: [point.lng, point.lat] },
    traumaLevel: overrides.traumaLevel ?? 2,
    specialties: ['Emergency'],
    beds: { total: 100, available: overrides.beds ?? 40 },
  });
}

export async function createAmbulance(options: {
  vehicleNumber: string;
  driver: UserDocument;
  hospital: HospitalDocument;
  at: { lat: number; lng: number };
  type?: AmbulanceType;
  status?: AmbulanceDocument['status'];
}): Promise<AmbulanceDocument> {
  const point = {
    type: 'Point' as const,
    coordinates: [options.at.lng, options.at.lat] as [number, number],
  };
  return Ambulance.create({
    vehicleNumber: options.vehicleNumber,
    type: options.type ?? 'ALS',
    status: options.status ?? 'AVAILABLE',
    driver: options.driver._id,
    hospital: options.hospital._id,
    crew: [{ name: options.driver.name, role: 'Driver' }],
    equipment: ['Stretcher'],
    baseLocation: point,
    location: point,
    lastSeenAt: new Date(),
  });
}

/** Signs in through the real endpoint and returns a bearer token. */
export async function login(app: Express, email: string): Promise<string> {
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email, password: TEST_PASSWORD })
    .expect(200);
  return (response.body as { accessToken: string }).accessToken;
}

/** Polls until `check` passes, for state produced by detached background work. */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  { timeoutMs = 8000, intervalMs = 60 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Condition was not met within ${timeoutMs}ms${lastError ? `: ${String(lastError)}` : ''}`,
  );
}
