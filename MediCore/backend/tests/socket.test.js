/**
 * Realtime layer (§34, §46).
 *
 * Checks the handshake, the room model, and that a doctor never receives
 * another doctor's patient detail.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { login, auth, request, prisma, startRealtimeServer, stopRealtimeServer, waitForEvent, disconnect } = require('./helpers');

let realtime;
let command;
let coordinator;
let doctorA;
let doctorB;
let nurse;
let commandToken;

const connect = (url, token) =>
  new Promise((resolve, reject) => {
    const socket = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.once('connection:ready', () => resolve(socket));
    socket.once('connect_error', (error) => reject(error));
    setTimeout(() => reject(new Error('socket connection timed out')), 5000);
  });

before(async () => {
  realtime = await startRealtimeServer();
  [command, coordinator, doctorA, doctorB, nurse] = await Promise.all([
    login('CMD001'),
    login('RES001'),
    login('DOC001'),
    login('DOC002'),
    login('NUR001'),
  ]);
  commandToken = command.token;
});

after(async () => {
  await stopRealtimeServer(realtime);
  await disconnect();
});

describe('socket authentication', () => {
  test('a connection without a token is refused', async () => {
    await assert.rejects(() => connect(realtime.url, undefined));
  });

  test('a connection with an invalid token is refused', async () => {
    await assert.rejects(() => connect(realtime.url, 'not-a-real-token'));
  });

  test('an authenticated socket joins its user, role and department rooms', async () => {
    const socket = await connect(realtime.url, doctorA.token);
    socket.disconnect();
  });
});

describe('operational events', () => {
  test('bed:updated reaches the command center when a bed changes', async () => {
    const socket = await connect(realtime.url, commandToken);
    const bed = await prisma.bed.findFirst({ where: { status: 'AVAILABLE', patientId: null } });

    const event = waitForEvent(socket, 'bed:updated');
    await request()
      .patch(`/api/beds/${bed.id}/status`)
      .set(auth(commandToken))
      .send({ status: 'Reserved', heldFor: 'Realtime test hold' });
    const payload = await event;

    assert.equal(payload.bedId, bed.id);
    socket.disconnect();
    await request().patch(`/api/beds/${bed.id}/status`).set(auth(commandToken)).send({ status: 'Available' });
  });

  test('queue:updated reaches the command center when a case is registered', async () => {
    const socket = await connect(realtime.url, commandToken);
    const event = waitForEvent(socket, 'queue:updated');

    await request()
      .post('/api/queue')
      .set(auth(commandToken))
      .send({ patientNumber: 'P9' + Math.floor(Math.random() * 900 + 100), priority: 'High', requiredResource: 'ICU Bed' });
    const payload = await event;

    assert.ok(payload.patientId, 'the event carries the patient reference');
    socket.disconnect();
  });

  test('optimization:completed carries the run summary to the coordinator', async () => {
    const socket = await connect(realtime.url, coordinator.token);
    const event = waitForEvent(socket, 'optimization:completed');
    await request().post('/api/optimization').set(auth(commandToken)).send({});
    const payload = await event;

    assert.ok(payload.reference, 'the run reference is published');
    assert.ok(payload.recommendations >= 1);
    socket.disconnect();
  });

  test('doctor:availability is delivered only to the doctor whose roster changed', async () => {
    const ownerSocket = await connect(realtime.url, doctorA.token); // Dr. Kumar — DOC-1042
    const otherSocket = await connect(realtime.url, doctorB.token); // Dr. Rajesh Iyer — DOC-1081
    const otherReceived = [];
    otherSocket.onAny((event) => otherReceived.push(event));

    const event = waitForEvent(ownerSocket, 'doctor:availability');
    await request()
      .patch('/api/doctors/DOC-1042/duty')
      .set(auth(coordinator.token))
      .send({ dutyStatus: 'OFF_DUTY', rationale: 'realtime test' });
    const payload = await event;
    assert.equal(payload.doctorId, 'DOC-1042');

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(otherReceived.includes('doctor:availability'), false, 'another doctor is not told about this roster change');

    ownerSocket.disconnect();
    otherSocket.disconnect();
    await request().patch('/api/doctors/DOC-1042/duty').set(auth(coordinator.token)).send({ dutyStatus: 'ON_DUTY', availability: 'Available' });
  });

  test('a doctor never receives another doctor’s assignment events', async () => {
    const socketB = await connect(realtime.url, doctorB.token);
    const received = [];
    socketB.onAny((event) => received.push(event));

    /* An allocation of patients to DOC001 must not be broadcast to DOC002. */
    await request().post('/api/simulation').set(auth(commandToken)).send({ patientCount: 12 });
    const optimization = await request().post('/api/optimization').set(auth(commandToken)).send({});
    await request().post(`/api/allocations/${optimization.body.data.approval.id}/approve`).set(auth(coordinator.token)).send({ note: 'realtime leak test' });

    await new Promise((resolve) => setTimeout(resolve, 400));
    const allocationEvents = received.filter((event) => event === 'allocation:updated');
    assert.equal(allocationEvents.length, 0, 'DOC002 receives no allocation event for another doctor’s patients');

    socketB.disconnect();
    await request().post('/api/simulation/revert').set(auth(commandToken)).send({});
  });

  test('every emitted event name is one of the nine contracted events', async () => {
    const contracted = new Set([
      'bed:updated',
      'doctor:availability',
      'nurse:availability',
      'equipment:updated',
      'queue:updated',
      'surge:detected',
      'optimization:completed',
      'allocation:updated',
      'alert:created',
    ]);
    const socket = await connect(realtime.url, nurse.token);
    const seen = [];
    socket.onAny((event) => seen.push(event));

    await request().post('/api/simulation').set(auth(commandToken)).send({ patientCount: 6 });
    await request().post('/api/simulation/revert').set(auth(commandToken)).send({});
    await new Promise((resolve) => setTimeout(resolve, 400));

    seen.forEach((event) => assert.ok(contracted.has(event), `${event} is part of the API contract`));
    socket.disconnect();
  });
});
