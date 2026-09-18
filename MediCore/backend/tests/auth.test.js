/**
 * Authentication and authorization (§12–14, §17).
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { request, login, auth, disconnect } = require('./helpers');

let tokens;

before(async () => {
  const [command, coordinator, doctor, nurse] = await Promise.all([
    login('CMD001'),
    login('RES001'),
    login('DOC001'),
    login('NUR001'),
  ]);
  tokens = { command, coordinator, doctor, nurse };
});

after(async () => {
  await disconnect();
});

describe('authentication', () => {
  test('login returns a token and the role that belongs to the account', async () => {
    const response = await request().post('/api/auth/login').send({ staffId: 'DOC001', password: 'demo123' });
    assert.equal(response.status, 200);
    assert.ok(response.body.token, 'a JWT is returned');
    assert.equal(response.body.user.role, 'doctor');
    assert.equal(response.body.user.staffRef, 'DOC-1042');
    assert.equal(response.body.user.password, undefined, 'no credential material is returned');
  });

  test('the role is never taken from the request body', async () => {
    const response = await request()
      .post('/api/auth/login')
      .send({ staffId: 'NUR001', password: 'demo123', role: 'command_center', permissions: ['allocations:confirm'] });
    assert.equal(response.status, 200);
    assert.equal(response.body.user.role, 'nurse');
    assert.ok(!response.body.user.permissions.includes('allocations:confirm'));
  });

  test('invalid password is rejected with the error envelope', async () => {
    const response = await request().post('/api/auth/login').send({ staffId: 'CMD001', password: 'nope-1234' });
    assert.equal(response.status, 401);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error.code, 'UNAUTHORIZED');
    assert.equal(response.body.error.stack, undefined);
  });

  test('unknown staff id returns the same generic message', async () => {
    const unknown = await request().post('/api/auth/login').send({ staffId: 'GHOST99', password: 'demo123' });
    const wrong = await request().post('/api/auth/login').send({ staffId: 'CMD001', password: 'wrong-pass' });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error.message, wrong.body.error.message);
  });

  test('a malformed login body fails validation with 400', async () => {
    const response = await request().post('/api/auth/login').send({ staffId: 'C' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(response.body.error.details));
  });

  test('protected routes require a token', async () => {
    const response = await request().get('/api/dashboard/overview');
    assert.equal(response.status, 401);
  });

  test('a tampered token is rejected', async () => {
    const response = await request().get('/api/dashboard/overview').set(auth(`${tokens.command.token}tampered`));
    assert.equal(response.status, 401);
  });

  test('GET /api/auth/me describes the session', async () => {
    const response = await request().get('/api/auth/me').set(auth(tokens.nurse.token));
    assert.equal(response.status, 200);
    assert.equal(response.body.role, 'nurse');
    assert.equal(response.body.staffRef, 'NUR-201');
    assert.equal(typeof response.body.unreadNotifications, 'number');
  });

  test('logout is recorded and answered', async () => {
    const response = await request().post('/api/auth/logout').set(auth(tokens.doctor.token));
    assert.equal(response.status, 200);
    assert.equal(response.body.loggedOut, true);
  });
});

describe('role authorization', () => {
  test('clinical staff cannot run a surge simulation', async () => {
    const response = await request().post('/api/simulation').set(auth(tokens.doctor.token)).send({ patientCount: 5 });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FORBIDDEN');
  });

  test('doctors cannot decide allocations', async () => {
    const response = await request().post('/api/allocations/APR-0001/approve').set(auth(tokens.doctor.token)).send({});
    assert.equal(response.status, 403);
  });

  test('the command center cannot approve allocations (separation of duties)', async () => {
    const response = await request().post('/api/allocations/APR-0001/approve').set(auth(tokens.command.token)).send({});
    assert.equal(response.status, 403);
  });

  test('nurses cannot change duty rosters', async () => {
    const response = await request().patch('/api/nurses/NUR-206/duty').set(auth(tokens.nurse.token)).send({ dutyStatus: 'ON_DUTY' });
    assert.equal(response.status, 403);
  });

  test('the resource coordinator can move a doctor off duty and back', async () => {
    const off = await request().patch('/api/doctors/DOC-1211/duty').set(auth(tokens.coordinator.token)).send({ dutyStatus: 'OFF_DUTY', rationale: 'shift handover test' });
    assert.equal(off.status, 200);
    assert.equal(off.body.data.dutyStatus, 'OFF_DUTY');

    const on = await request().patch('/api/doctors/DOC-1211/duty').set(auth(tokens.coordinator.token)).send({ dutyStatus: 'ON_DUTY', availability: 'Available' });
    assert.equal(on.status, 200);
    assert.equal(on.body.data.availability, 'Available');
  });

  test('invalid query parameters fail validation with 400', async () => {
    const response = await request().get('/api/patients?priority=Extreme').set(auth(tokens.command.token));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});
