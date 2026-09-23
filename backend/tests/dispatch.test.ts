/**
 * End-to-end dispatch behaviour, exercised through the real HTTP API against a
 * real database. These are the tests that would catch a regression capable of
 * sending the wrong ambulance, or none at all.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { Ambulance, EmergencyRequest } from '../src/models/index.js';
import {
  CENTRE,
  createAmbulance,
  createHospital,
  createUser,
  login,
  offset,
  resetTestData,
  startTestDatabase,
  stopTestDatabase,
  testApp,
  waitFor,
} from './helpers.js';

let app: Express;

beforeAll(async () => {
  await startTestDatabase();
  app = testApp();
});

afterAll(stopTestDatabase);
beforeEach(resetTestData);

/** Builds a patient, a hospital and one or more crewed vehicles. */
async function scenario(
  vehicles: Array<{ number: string; metresAway: number; type?: 'BLS' | 'ALS' | 'MICU' | 'PTV' }>,
) {
  const hospital = await createHospital(offset(CENTRE, 1200, 800));
  const patient = await createUser({ email: 'caller@example.com', name: 'Caller One' });

  const crews = [];
  for (const [index, spec] of vehicles.entries()) {
    const driver = await createUser({
      email: `crew${index}@example.com`,
      role: 'driver',
      name: `Crew ${index}`,
    });
    const ambulance = await createAmbulance({
      vehicleNumber: spec.number,
      driver,
      hospital,
      at: offset(CENTRE, spec.metresAway, 0),
      ...(spec.type ? { type: spec.type } : {}),
    });
    crews.push({ driver, ambulance });
  }

  const patientToken = await login(app, 'caller@example.com');
  return { hospital, patient, patientToken, crews };
}

async function raiseSos(
  token: string,
  body: Record<string, unknown> = {},
): Promise<{ id: string; code: string; priority: string }> {
  const response = await request(app)
    .post('/api/emergency')
    .set('Authorization', `Bearer ${token}`)
    .send({ emergencyType: 'CARDIAC', pickup: CENTRE, ...body })
    .expect(201);
  return response.body.request;
}

/** Waits for the detached dispatcher to place an offer with some vehicle. */
async function waitForOffer(vehicleNumber?: string) {
  return waitFor(async () => {
    const vehicle = await Ambulance.findOne({
      status: 'OFFERED',
      ...(vehicleNumber ? { vehicleNumber } : {}),
    });
    return vehicle ?? null;
  });
}

describe('raising an emergency', () => {
  it('triages the call and returns a case immediately', async () => {
    const { patientToken } = await scenario([{ number: 'TG09AA0001', metresAway: 500 }]);
    const created = await raiseSos(patientToken, { emergencyType: 'CARDIAC' });

    expect(created.code).toMatch(/^SAS-[A-Z0-9]{5}$/);
    // Cardiac is immediately life-threatening.
    expect(created.priority).toBe('P1');
    expect(created.status).toBe('PENDING');
  });

  it('offers the case to the nearest suitable vehicle', async () => {
    const { patientToken } = await scenario([
      { number: 'TG09FAR001', metresAway: 6000 },
      { number: 'TG09NEAR01', metresAway: 400 },
    ]);
    await raiseSos(patientToken);

    const offered = await waitForOffer();
    expect(offered.vehicleNumber).toBe('TG09NEAR01');
  });

  it('skips a vehicle that is not clinically capable of the case', async () => {
    // A basic vehicle is nearer, but a cardiac call needs advanced life support.
    const { patientToken } = await scenario([
      { number: 'TG09BLS001', metresAway: 300, type: 'BLS' },
      { number: 'TG09ALS001', metresAway: 3000, type: 'ALS' },
    ]);
    await raiseSos(patientToken, { emergencyType: 'CARDIAC' });

    const offered = await waitForOffer();
    expect(offered.vehicleNumber).toBe('TG09ALS001');
  });

  it('never offers a vehicle that is off duty', async () => {
    const hospital = await createHospital();
    const driver = await createUser({ email: 'offduty@example.com', role: 'driver' });
    await createAmbulance({
      vehicleNumber: 'TG09OFF001',
      driver,
      hospital,
      at: offset(CENTRE, 200, 0),
      status: 'OFFLINE',
    });
    await createUser({ email: 'caller@example.com' });
    const token = await login(app, 'caller@example.com');

    const created = await raiseSos(token);

    const settled = await waitFor(async () => {
      const doc = await EmergencyRequest.findById(created.id);
      return doc?.status === 'NO_AMBULANCE_AVAILABLE' ? doc : null;
    });
    expect(settled.status).toBe('NO_AMBULANCE_AVAILABLE');
    expect(await Ambulance.findOne({ status: 'OFFERED' })).toBeNull();
  });

  it('refuses a second emergency while one is already open', async () => {
    const { patientToken } = await scenario([{ number: 'TG09AA0001', metresAway: 500 }]);
    await raiseSos(patientToken);

    const response = await request(app)
      .post('/api/emergency')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ emergencyType: 'TRAUMA', pickup: CENTRE })
      .expect(409);

    expect(response.body.error.code).toBe('CONFLICT');
  });

  it('rejects coordinates that are not on the planet', async () => {
    const { patientToken } = await scenario([{ number: 'TG09AA0001', metresAway: 500 }]);
    await request(app)
      .post('/api/emergency')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ emergencyType: 'TRAUMA', pickup: { lat: 999, lng: 77 } })
      .expect(400);
  });
});

describe('the offer cascade', () => {
  it('moves the case to the next crew when the first declines', async () => {
    const { patientToken, crews } = await scenario([
      { number: 'TG09NEAR01', metresAway: 300 },
      { number: 'TG09NEXT01', metresAway: 2000 },
    ]);
    const created = await raiseSos(patientToken);

    await waitForOffer('TG09NEAR01');
    const decliningDriver = crews[0]!.driver;
    const declineToken = await login(app, decliningDriver.email);

    await request(app)
      .post('/api/driver/offer')
      .set('Authorization', `Bearer ${declineToken}`)
      .send({ requestId: created.id, accept: false, reason: 'Vehicle fault' })
      .expect(200);

    const second = await waitForOffer('TG09NEXT01');
    expect(second.vehicleNumber).toBe('TG09NEXT01');

    // The declining vehicle is back in service, not stuck holding the case.
    const released = await Ambulance.findOne({ vehicleNumber: 'TG09NEAR01' });
    expect(released?.status).toBe('AVAILABLE');
    expect(released?.stats.declinedOffers).toBe(1);
  });

  it('passes the case on when a crew does not answer in time', async () => {
    // The offer window is five seconds in tests; nobody answers the first offer.
    const { patientToken } = await scenario([
      { number: 'TG09SLOW01', metresAway: 300 },
      { number: 'TG09BACKUP', metresAway: 2500 },
    ]);
    await raiseSos(patientToken);
    await waitForOffer('TG09SLOW01');

    const next = await waitFor(async () => {
      const vehicle = await Ambulance.findOne({ vehicleNumber: 'TG09BACKUP', status: 'OFFERED' });
      return vehicle ?? null;
    });
    expect(next.status).toBe('OFFERED');
  });

  it('gives up cleanly when every nearby crew refuses', async () => {
    const { patientToken, crews } = await scenario([{ number: 'TG09ONLY01', metresAway: 300 }]);
    const created = await raiseSos(patientToken);
    await waitForOffer('TG09ONLY01');

    const token = await login(app, crews[0]!.driver.email);
    await request(app)
      .post('/api/driver/offer')
      .set('Authorization', `Bearer ${token}`)
      .send({ requestId: created.id, accept: false })
      .expect(200);

    const settled = await waitFor(async () => {
      const doc = await EmergencyRequest.findById(created.id);
      return doc?.status === 'NO_AMBULANCE_AVAILABLE' ? doc : null;
    });
    expect(settled.status).toBe('NO_AMBULANCE_AVAILABLE');
  });

  it('commits one vehicle to only one case when two emergencies race', async () => {
    const hospital = await createHospital();
    const driver = await createUser({ email: 'solo@example.com', role: 'driver' });
    await createAmbulance({
      vehicleNumber: 'TG09SOLO01',
      driver,
      hospital,
      at: offset(CENTRE, 200, 0),
    });

    await createUser({ email: 'first@example.com' });
    await createUser({ email: 'second@example.com' });
    const firstToken = await login(app, 'first@example.com');
    const secondToken = await login(app, 'second@example.com');

    // Both callers press SOS at the same moment.
    await Promise.all([
      request(app)
        .post('/api/emergency')
        .set('Authorization', `Bearer ${firstToken}`)
        .send({ emergencyType: 'CARDIAC', pickup: CENTRE })
        .expect(201),
      request(app)
        .post('/api/emergency')
        .set('Authorization', `Bearer ${secondToken}`)
        .send({ emergencyType: 'CARDIAC', pickup: offset(CENTRE, 100, 100) })
        .expect(201),
    ]);

    await waitForOffer('TG09SOLO01');

    // Exactly one case holds the vehicle; the other must report no availability
    // rather than double-booking it.
    const offeredCases = await EmergencyRequest.find({
      'dispatchAttempts.outcome': 'PENDING',
    });
    expect(offeredCases).toHaveLength(1);

    const loser = await waitFor(async () => {
      const doc = await EmergencyRequest.findOne({ status: 'NO_AMBULANCE_AVAILABLE' });
      return doc ?? null;
    });
    expect(loser.status).toBe('NO_AMBULANCE_AVAILABLE');
  });
});

describe('working a case through to completion', () => {
  async function acceptedCase() {
    const context = await scenario([{ number: 'TG09RUN001', metresAway: 400 }]);
    const created = await raiseSos(context.patientToken);
    await waitForOffer('TG09RUN001');

    const driverToken = await login(app, context.crews[0]!.driver.email);
    await request(app)
      .post('/api/driver/offer')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ requestId: created.id, accept: true })
      .expect(200);

    return { ...context, created, driverToken };
  }

  it('assigns the vehicle on acceptance and picks a destination hospital', async () => {
    const { created, driverToken } = await acceptedCase();

    const response = await request(app)
      .get(`/api/emergency/${created.id}`)
      .set('Authorization', `Bearer ${driverToken}`)
      .expect(200);

    expect(response.body.request.status).toBe('ASSIGNED');
    expect(response.body.request.ambulance.vehicleNumber).toBe('TG09RUN001');
    expect(response.body.request.hospital).not.toBeNull();

    const vehicle = await Ambulance.findOne({ vehicleNumber: 'TG09RUN001' });
    expect(vehicle?.status).toBe('DISPATCHED');
    expect(vehicle?.activeRequest?.toString()).toBe(created.id);
  });

  it('refuses a status jump that skips a step', async () => {
    const { created, driverToken } = await acceptedCase();

    const response = await request(app)
      .post('/api/driver/status')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ requestId: created.id, status: 'TRANSPORTING' })
      .expect(422);

    expect(response.body.error.message).toContain('EN_ROUTE_TO_SCENE');
  });

  it('refuses a status update from a crew that is not assigned', async () => {
    const { created } = await acceptedCase();

    const outsider = await createUser({ email: 'outsider@example.com', role: 'driver' });
    const hospital = await createHospital();
    await createAmbulance({
      vehicleNumber: 'TG09OTHER1',
      driver: outsider,
      hospital,
      at: offset(CENTRE, 5000, 0),
    });
    const outsiderToken = await login(app, 'outsider@example.com');

    await request(app)
      .post('/api/driver/status')
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ requestId: created.id, status: 'EN_ROUTE_TO_SCENE' })
      .expect(403);
  });

  it('records the response time and frees the vehicle at the end', async () => {
    const { created, driverToken, hospital } = await acceptedCase();

    const step = async (status: string, extra: Record<string, unknown> = {}) =>
      request(app)
        .post('/api/driver/status')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ requestId: created.id, status, ...extra })
        .expect(200);

    await step('EN_ROUTE_TO_SCENE');
    await step('ON_SCENE');
    await step('TRANSPORTING', { destinationHospitalId: hospital._id.toString() });
    await step('ARRIVED_AT_HOSPITAL');
    const final = await step('COMPLETED');

    expect(final.body.request.status).toBe('COMPLETED');
    expect(final.body.request.responseSeconds).toBeGreaterThanOrEqual(0);
    // Every transition is on the record.
    expect(final.body.request.timeline.map((entry: { status: string }) => entry.status)).toContain(
      'ON_SCENE',
    );

    const vehicle = await Ambulance.findOne({ vehicleNumber: 'TG09RUN001' });
    expect(vehicle?.status).toBe('AVAILABLE');
    expect(vehicle?.activeRequest).toBeNull();
    expect(vehicle?.stats.completedTrips).toBe(1);
  });

  it('takes a bed when the patient arrives at hospital', async () => {
    const { created, driverToken, hospital } = await acceptedCase();
    const bedsBefore = hospital.beds.available;

    for (const status of ['EN_ROUTE_TO_SCENE', 'ON_SCENE']) {
      await request(app)
        .post('/api/driver/status')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ requestId: created.id, status })
        .expect(200);
    }
    await request(app)
      .post('/api/driver/status')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        requestId: created.id,
        status: 'TRANSPORTING',
        destinationHospitalId: hospital._id.toString(),
      })
      .expect(200);
    await request(app)
      .post('/api/driver/status')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ requestId: created.id, status: 'ARRIVED_AT_HOSPITAL' })
      .expect(200);

    const { Hospital } = await import('../src/models/index.js');
    const after = await Hospital.findById(hospital._id);
    expect(after?.beds.available).toBe(bedsBefore - 1);
  });
});

describe('cancellation', () => {
  it('frees an offered vehicle when the caller cancels', async () => {
    const { patientToken } = await scenario([{ number: 'TG09CAN001', metresAway: 300 }]);
    const created = await raiseSos(patientToken);
    await waitForOffer('TG09CAN001');

    await request(app)
      .post(`/api/emergency/${created.id}/cancel`)
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ reason: 'Made other arrangements' })
      .expect(200);

    const vehicle = await Ambulance.findOne({ vehicleNumber: 'TG09CAN001' });
    expect(vehicle?.status).toBe('AVAILABLE');
    expect(vehicle?.activeRequest).toBeNull();
  });

  it('stops the caller cancelling once the crew is with them', async () => {
    const context = await scenario([{ number: 'TG09ONSC01', metresAway: 300 }]);
    const created = await raiseSos(context.patientToken);
    await waitForOffer('TG09ONSC01');

    const driverToken = await login(app, context.crews[0]!.driver.email);
    await request(app)
      .post('/api/driver/offer')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ requestId: created.id, accept: true })
      .expect(200);

    for (const status of ['EN_ROUTE_TO_SCENE', 'ON_SCENE']) {
      await request(app)
        .post('/api/driver/status')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ requestId: created.id, status })
        .expect(200);
    }

    await request(app)
      .post(`/api/emergency/${created.id}/cancel`)
      .set('Authorization', `Bearer ${context.patientToken}`)
      .send({ reason: 'Changed my mind' })
      .expect(409);
  });
});

describe('case visibility', () => {
  it('hides a case from an unrelated patient', async () => {
    const { patientToken } = await scenario([{ number: 'TG09PRIV01', metresAway: 400 }]);
    const created = await raiseSos(patientToken);

    await createUser({ email: 'nosy@example.com' });
    const nosyToken = await login(app, 'nosy@example.com');

    await request(app)
      .get(`/api/emergency/${created.id}`)
      .set('Authorization', `Bearer ${nosyToken}`)
      .expect(403);
  });

  it('shows the case to the crew it was offered to', async () => {
    const context = await scenario([{ number: 'TG09SEE001', metresAway: 400 }]);
    const created = await raiseSos(context.patientToken);
    await waitForOffer('TG09SEE001');

    const driverToken = await login(app, context.crews[0]!.driver.email);
    const response = await request(app)
      .get(`/api/emergency/${created.id}`)
      .set('Authorization', `Bearer ${driverToken}`)
      .expect(200);

    expect(response.body.request.patient.name).toBe('Caller One');
  });

  it('lets the control room see every open case', async () => {
    const { patientToken } = await scenario([{ number: 'TG09ADM001', metresAway: 400 }]);
    await raiseSos(patientToken);

    await createUser({ email: 'control@example.com', role: 'admin' });
    const adminToken = await login(app, 'control@example.com');

    const response = await request(app)
      .get('/api/admin/requests/active')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.items.length).toBeGreaterThan(0);
  });
});

describe('live tracking', () => {
  it('accepts a position ping and rejects an impossible one', async () => {
    const context = await scenario([{ number: 'TG09GPS001', metresAway: 400 }]);
    const driverToken = await login(app, context.crews[0]!.driver.email);

    const moved = offset(CENTRE, 900, 200);
    await request(app)
      .post('/api/driver/location')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ lat: moved.lat, lng: moved.lng, speed: 12 })
      .expect(200);

    const vehicle = await Ambulance.findOne({ vehicleNumber: 'TG09GPS001' });
    expect(vehicle?.location.coordinates[1]).toBeCloseTo(moved.lat, 4);

    // Out-of-range coordinates are refused by validation, not stored.
    await request(app)
      .post('/api/driver/location')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ lat: 91, lng: 200 })
      .expect(400);
  });

  it('will not let a crew go off duty during a live case', async () => {
    const context = await scenario([{ number: 'TG09DUTY01', metresAway: 300 }]);
    const created = await raiseSos(context.patientToken);
    await waitForOffer('TG09DUTY01');

    const driverToken = await login(app, context.crews[0]!.driver.email);
    await request(app)
      .post('/api/driver/offer')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ requestId: created.id, accept: true })
      .expect(200);

    await request(app)
      .post('/api/driver/duty')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ status: 'OFFLINE' })
      .expect(409);
  });
});

describe('control-room reporting', () => {
  it('summarises the fleet and the day without loading documents', async () => {
    const { patientToken } = await scenario([
      { number: 'TG09RPT001', metresAway: 400 },
      { number: 'TG09RPT002', metresAway: 900 },
    ]);
    await raiseSos(patientToken);

    await createUser({ email: 'stats@example.com', role: 'admin' });
    const adminToken = await login(app, 'stats@example.com');

    const response = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const stats = response.body;
    expect(stats.requestsToday).toBeGreaterThanOrEqual(1);
    expect(stats.activeRequests).toBeGreaterThanOrEqual(1);
    expect(stats.byPriority.P1).toBeGreaterThanOrEqual(1);
    // Every vehicle status appears, so the dashboard never renders undefined.
    expect(Object.keys(stats.fleet)).toContain('AVAILABLE');
    expect(stats.fleet.AVAILABLE + stats.fleet.OFFERED).toBe(2);
    expect(stats.hospitalBeds.total).toBeGreaterThan(0);
  });

  it('returns an hourly series for the last day', async () => {
    const { patientToken } = await scenario([{ number: 'TG09TS0001', metresAway: 400 }]);
    await raiseSos(patientToken);

    await createUser({ email: 'series@example.com', role: 'admin' });
    const adminToken = await login(app, 'series@example.com');

    const response = await request(app)
      .get('/api/admin/timeseries')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(Array.isArray(response.body.items)).toBe(true);
    expect(response.body.items.length).toBeGreaterThan(0);
    expect(response.body.items[0].bucket).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00$/);
  });

  it('lists hospitals near a point, nearest first', async () => {
    const { patientToken } = await scenario([{ number: 'TG09HOS001', metresAway: 400 }]);
    await createHospital(offset(CENTRE, 9000, 0), { name: 'Far Hospital' });

    const response = await request(app)
      .get('/api/hospitals/nearby')
      .query({ lat: CENTRE.lat, lng: CENTRE.lng, radiusKm: 20 })
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(200);

    expect(response.body.items.length).toBeGreaterThanOrEqual(2);
    const distances = response.body.items.map((h: { distanceMetres: number }) => h.distanceMetres);
    expect(distances).toEqual([...distances].sort((a: number, b: number) => a - b));
  });
});

describe('service and personal statistics', () => {
  it('reports the service record to an ordinary patient', async () => {
    const { patientToken } = await scenario([{ number: 'TG09STA001', metresAway: 400 }]);
    await raiseSos(patientToken);

    const response = await request(app)
      .get('/api/stats/service')
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(200);

    const stats = response.body;
    expect(stats.activeNow).toBeGreaterThanOrEqual(1);
    expect(stats.ambulancesTotal).toBe(1);
    expect(stats.hospitalsCovered).toBeGreaterThanOrEqual(1);
    expect(typeof stats.casesCompleted).toBe('number');

    // Aggregate only: nothing here may identify a caller or a location.
    const body = JSON.stringify(stats);
    expect(body).not.toContain('Caller One');
    expect(body).not.toContain('pickup');
  });

  it('counts a completed journey towards both records', async () => {
    const context = await scenario([{ number: 'TG09STA002', metresAway: 400 }]);
    const created = await raiseSos(context.patientToken);
    await waitForOffer('TG09STA002');

    const driverToken = await login(app, context.crews[0]!.driver.email);
    await request(app)
      .post('/api/driver/offer')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ requestId: created.id, accept: true })
      .expect(200);

    for (const status of ['EN_ROUTE_TO_SCENE', 'ON_SCENE']) {
      await request(app)
        .post('/api/driver/status')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ requestId: created.id, status })
        .expect(200);
    }
    await request(app)
      .post('/api/driver/status')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        requestId: created.id,
        status: 'TRANSPORTING',
        destinationHospitalId: context.hospital._id.toString(),
      })
      .expect(200);
    for (const status of ['ARRIVED_AT_HOSPITAL', 'COMPLETED']) {
      await request(app)
        .post('/api/driver/status')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ requestId: created.id, status })
        .expect(200);
    }

    const service = await request(app)
      .get('/api/stats/service')
      .set('Authorization', `Bearer ${context.patientToken}`)
      .expect(200);
    expect(service.body.casesCompleted).toBe(1);
    expect(service.body.activeNow).toBe(0);
    expect(service.body.averageResponseSeconds).toBeGreaterThanOrEqual(0);

    const mine = await request(app)
      .get('/api/stats/me')
      .set('Authorization', `Bearer ${context.patientToken}`)
      .expect(200);
    expect(mine.body.totalRequests).toBe(1);
    expect(mine.body.completed).toBe(1);
    expect(mine.body.lastRequestAt).toBeTruthy();
  });

  it('scopes personal statistics to the caller asking', async () => {
    const { patientToken } = await scenario([{ number: 'TG09STA003', metresAway: 400 }]);
    await raiseSos(patientToken);

    await createUser({ email: 'bystander@example.com' });
    const otherToken = await login(app, 'bystander@example.com');

    const mine = await request(app)
      .get('/api/stats/me')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200);

    // Someone else's emergency is not part of this caller's record.
    expect(mine.body.totalRequests).toBe(0);
    expect(mine.body.lastRequestAt).toBeNull();
  });

  it('requires a signed-in user', async () => {
    await request(app).get('/api/stats/service').expect(401);
    await request(app).get('/api/stats/me').expect(401);
  });
});

describe('capability matching at scale', () => {
  it('finds a capable vehicle even when nearer vehicles crowd the search', async () => {
    // The geospatial query returns the nearest vehicles; capability is then
    // checked on the results. If enough unsuitable vehicles sit closer to the
    // patient than the suitable one, the suitable one falls outside the fetched
    // window and the case is declared unservable -- with a capable ambulance
    // sitting well inside the search radius.
    const hospital = await createHospital();
    await createUser({ email: 'crowded@example.com' });
    const patientToken = await login(app, 'crowded@example.com');

    // Sixteen basic vehicles, all very close.
    for (let index = 0; index < 16; index += 1) {
      const driver = await createUser({ email: `bls${index}@example.com`, role: 'driver' });
      await createAmbulance({
        vehicleNumber: `TG09BLS${String(index).padStart(3, '0')}`,
        driver,
        hospital,
        at: offset(CENTRE, 100 + index * 10, 0),
        type: 'BLS',
      });
    }

    // One advanced vehicle, farther out but well within the search radius.
    const alsDriver = await createUser({ email: 'als@example.com', role: 'driver' });
    await createAmbulance({
      vehicleNumber: 'TG09ALSFAR',
      driver: alsDriver,
      hospital,
      at: offset(CENTRE, 3000, 0),
      type: 'ALS',
    });

    // Cardiac needs advanced life support; none of the sixteen qualify.
    await request(app)
      .post('/api/emergency')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ emergencyType: 'CARDIAC', pickup: CENTRE })
      .expect(201);

    const offered = await waitForOffer();
    expect(offered.vehicleNumber).toBe('TG09ALSFAR');
  });
});
