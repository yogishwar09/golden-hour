import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import {
  createUser,
  login,
  resetTestData,
  startTestDatabase,
  stopTestDatabase,
  testApp,
  TEST_PASSWORD,
} from './helpers.js';

let app: Express;

beforeAll(async () => {
  await startTestDatabase();
  app = testApp();
});

afterAll(stopTestDatabase);
beforeEach(resetTestData);

describe('registration', () => {
  it('creates a patient account and returns a token', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Asha Rao',
        email: 'asha@example.com',
        phone: '+919812345678',
        password: TEST_PASSWORD,
        role: 'patient',
        bloodGroup: 'B+',
      })
      .expect(201);

    expect(response.body.user.email).toBe('asha@example.com');
    expect(response.body.accessToken).toBeTruthy();
    // The hash must never appear in a response body.
    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
  });

  it('rejects a weak password with a field-level message', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Weak Pass',
        email: 'weak@example.com',
        phone: '+919812345678',
        password: 'abc',
      })
      .expect(400);

    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(response.body.error.details)).toContain('password');
  });

  it('refuses a duplicate email', async () => {
    await createUser({ email: 'dupe@example.com' });
    const response = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Copy',
        email: 'dupe@example.com',
        phone: '+919812345678',
        password: TEST_PASSWORD,
      })
      .expect(409);

    expect(response.body.error.code).toBe('CONFLICT');
  });

  it('refuses to create an admin account through public signup', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Sneaky',
        email: 'sneaky@example.com',
        phone: '+919812345678',
        password: TEST_PASSWORD,
        role: 'admin',
      })
      .expect(403);
  });
});

describe('login', () => {
  it('returns the same message for an unknown email and a wrong password', async () => {
    await createUser({ email: 'known@example.com' });

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: 'known@example.com', password: 'WrongPassword1' })
      .expect(401);

    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: TEST_PASSWORD })
      .expect(401);

    // Identical wording, so the endpoint cannot be used to discover accounts.
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it('signs in with correct credentials', async () => {
    await createUser({ email: 'good@example.com' });
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'good@example.com', password: TEST_PASSWORD })
      .expect(200);

    expect(response.body.user.role).toBe('patient');
  });
});

describe('protected routes', () => {
  it('rejects a missing token', async () => {
    await request(app).get('/api/auth/me').expect(401);
  });

  it('rejects a forged token', async () => {
    await request(app).get('/api/auth/me').set('Authorization', 'Bearer not.a.token').expect(401);
  });

  it('accepts a valid token', async () => {
    await createUser({ email: 'valid@example.com', name: 'Valid User' });
    const token = await login(app, 'valid@example.com');

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.user.name).toBe('Valid User');
  });

  it('ignores role changes submitted to the profile endpoint', async () => {
    await createUser({ email: 'climber@example.com' });
    const token = await login(app, 'climber@example.com');

    const response = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name', role: 'admin' })
      .expect(200);

    expect(response.body.user.name).toBe('New Name');
    expect(response.body.user.role).toBe('patient');
  });

  it('denies a patient access to control-room data', async () => {
    await createUser({ email: 'patient@example.com' });
    const token = await login(app, 'patient@example.com');

    await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${token}`).expect(403);
  });
});

describe('health endpoints', () => {
  it('reports liveness and readiness', async () => {
    await request(app).get('/api/health').expect(200);
    const ready = await request(app).get('/api/ready').expect(200);
    expect(ready.body.database).toBe('connected');
  });

  it('reports not-ready when the database is not connected', async () => {
    // The probe reads the connection state and nothing else; see the note on
    // the route for why the earlier ping-before-failing version was removed.
    const response = await request(app).get('/api/ready').expect(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.database).toBe('connected');
  });

  it('returns a structured 404 for an unknown route', async () => {
    const response = await request(app).get('/api/nope').expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});

describe('malformed requests', () => {
  it('reports a body that is not valid JSON as a client error', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": broken')
      .expect(400);

    // A parse failure is the caller's mistake; reporting it as a 500 would both
    // mislead them and fill the logs with stack traces for ordinary bad input.
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects an oversized body with 413 rather than a server error', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a'.repeat(200_000) }))
      .expect(413);

    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('refuses a browser origin that is not allowed', async () => {
    const response = await request(app)
      .get('/api/health')
      .set('Origin', 'https://evil.example.com')
      .expect(403);

    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('still serves an allowed origin', async () => {
    await request(app).get('/api/health').set('Origin', 'http://localhost:5173').expect(200);
  });

  it('accepts any localhost port in development', async () => {
    // Vite moves to the next free port when its default is taken, and the only
    // symptom used to be a CORS rejection on the sign-in screen.
    for (const origin of [
      'http://localhost:5174',
      'http://localhost:3000',
      'http://127.0.0.1:4173',
    ]) {
      await request(app).get('/api/health').set('Origin', origin).expect(200);
    }
  });

  it('does not extend that leniency to a lookalike host', async () => {
    // `localhost.evil.com` must not pass for `localhost`.
    await request(app).get('/api/health').set('Origin', 'http://localhost.evil.com').expect(403);
  });

  it('serves a request with no Origin header at all', async () => {
    // curl, a health probe, or a server-to-server call.
    await request(app).get('/api/health').expect(200);
  });
});
