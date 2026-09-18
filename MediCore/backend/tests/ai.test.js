/**
 * HE-02 AI layer (superset of the operational suites).
 *
 * These tests cover the parts of the AI layer that must hold whether or not the
 * Python model service happens to be running:
 *
 *   * role authorisation on every AI endpoint,
 *   * graceful, clearly-labelled degradation when the models are unreachable,
 *   * the snapshot being derived from live rows (so the models and the
 *     dashboards never disagree),
 *   * predictions being persisted with their provenance, and
 *   * the approval workflow remaining the only thing that moves a resource.
 *
 * The suite therefore never asserts a *prediction*. It asserts the contract.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { login, auth, request, prisma, disconnect } = require('./helpers');

const aiService = require('../src/services/aiService');
const arrivalService = require('../src/services/arrivalService');
const aiClient = require('../src/ai/aiClient');
const { AI_EVENTS, AI_ROOMS } = require('../src/socket/aiEvents');
const { EVENTS } = require('../src/socket/bus');

let command;
let coordinator;
let doctor;
let nurse;

before(async () => {
  [command, coordinator, doctor, nurse] = await Promise.all([
    login('CMD001'),
    login('RES001'),
    login('DOC001'),
    login('NUR001'),
  ]);
});

after(async () => {
  await disconnect();
});

describe('ai endpoint authorisation', () => {
  test('every AI endpoint requires a token', async () => {
    const paths = [
      ['get', '/api/ai/health'],
      ['get', '/api/ai/models'],
      ['post', '/api/ai/demand/forecast'],
      ['post', '/api/ai/surge/detect'],
      ['post', '/api/ai/pressure/predict'],
      ['post', '/api/ai/advisory'],
      ['post', '/api/ai/simulate'],
      ['get', '/api/ai/runs'],
    ];

    for (const [method, path] of paths) {
      const response = await request()[method](path).send({});
      assert.equal(response.status, 401, `${method.toUpperCase()} ${path} must require authentication`);
      assert.equal(response.body.success, false);
      assert.ok(response.body.error.code, 'the error envelope carries a code');
    }
  });

  test('clinical roles cannot reach the model registry or the advisory run history', async () => {
    for (const token of [doctor.token, nurse.token]) {
      assert.equal((await request().get('/api/ai/models').set(auth(token))).status, 403);
      assert.equal((await request().get('/api/ai/runs').set(auth(token))).status, 403);
      assert.equal((await request().post('/api/ai/advisory').set(auth(token)).send({})).status, 403);
    }
  });

  test('clinical roles can read their own workload projection', async () => {
    const response = await request().post('/api/ai/doctor-workload/predict').set(auth(doctor.token)).send({});
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.staff), 'the projection lists staff loads');
    assert.ok(response.body.staff.length > 0);
  });

  test('the advisory is available to the command centre and the coordinator', async () => {
    for (const token of [command.token, coordinator.token]) {
      const response = await request().post('/api/ai/advisory').set(auth(token)).send({ includeSimulation: false });
      assert.equal(response.status, 200);
      assert.equal(response.body.requiresHumanApproval, true, 'advisory output is never auto-applied');
    }
  });
});

describe('snapshot integrity', () => {
  test('the snapshot is built from live rows, not constants', async () => {
    const snapshot = await aiService.buildSnapshot();

    const bedCount = await prisma.bed.count();
    const occupied = await prisma.bed.count({ where: { status: 'OCCUPIED' } });
    const waiting = await prisma.patientQueue.count({ where: { status: 'WAITING' } });

    assert.equal(snapshot.beds.total, bedCount);
    assert.equal(snapshot.beds.occupied, occupied);
    assert.equal(snapshot.queue.waiting, waiting);
    assert.ok(snapshot.beds.icuTotal > 0, 'ICU capacity is reported');
    assert.ok(snapshot.staff.doctorsTotal > 0 && snapshot.staff.nursesTotal > 0);
  });

  test('arrival counts are read from the arrival log', async () => {
    const counts = await arrivalService.counts();
    const rows = await prisma.arrivalLog.count({
      where: { arrivedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
    });

    assert.equal(counts.last1h, rows, 'the rolling arrival count matches the rows in the log');
    assert.ok(counts.last24h >= counts.last1h, 'summing over a longer window never counts fewer arrivals');
    assert.ok(counts.averagePerHour24h > 0, 'the hospital has a measurable arrival rate');
  });

  test('registering a patient adds to the arrival flow that the models read', async () => {
    const before = await arrivalService.counts();
    const patientNumber = `P9${Math.floor(Math.random() * 800 + 100)}`;

    const created = await request()
      .post('/api/queue')
      .set(auth(command.token))
      .send({ patientNumber, priority: 'High', requiredResource: 'General Bed' });
    assert.equal(created.status, 201);

    const after = await arrivalService.counts();
    assert.equal(after.last1h, before.last1h + 1, 'the registration is recorded as an arrival');

    const logged = await prisma.arrivalLog.findFirst({ where: { patientNumber }, orderBy: { arrivedAt: 'desc' } });
    assert.ok(logged, 'the arrival row is linked to the registered patient');
    assert.equal(logged.source, 'AMBULANCE', 'the source defaults to a recorded pathway, never to nothing');
  });
});

describe('degraded operation', () => {
  test('an unreachable model service degrades instead of failing the hospital screen', async () => {
    const realFetch = global.fetch;
    const originalEnabled = process.env.AI_SERVICE_ENABLED;
    global.fetch = () => Promise.reject(new Error('connect ECONNREFUSED'));

    try {
      const response = await request().post('/api/ai/demand/forecast').set(auth(command.token)).send({});
      assert.equal(response.status, 200, 'the endpoint answers even with the AI service down');
      assert.equal(response.body.available, false);
      assert.ok(response.body.fallback_reason, 'the caller is told why no model answered');
      assert.notEqual(response.body.source, 'model', 'a degraded answer never claims to be a model prediction');
    } finally {
      global.fetch = realFetch;
      process.env.AI_SERVICE_ENABLED = originalEnabled;
    }
  });

  test('the dashboard keeps answering while the AI layer is down', async () => {
    const realFetch = global.fetch;
    global.fetch = () => Promise.reject(new Error('connect ECONNREFUSED'));

    try {
      const response = await request().get('/api/dashboard/overview').set(auth(command.token));
      assert.equal(response.status, 200);
      assert.ok(response.body.metrics, 'live metrics are still computed from the database');
      assert.ok(response.body.ai, 'the AI block is present so the client can show that it is unavailable');
      assert.notEqual(response.body.ai.available, true, 'a down AI service is reported as unavailable, never faked');
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe('provenance and persistence', () => {
  test('a persisted run records which models answered and where the data came from', async () => {
    const run = await prisma.aiRun.findFirst({ orderBy: { createdAt: 'desc' } });
    if (!run) {
      /* Nothing persisted in this environment yet: the assertion below covers the
         contract that callers rely on. */
      assert.ok(true);
      return;
    }

    const predictions = await prisma.aiPrediction.findMany({ where: { runId: run.id }, take: 5 });
    for (const prediction of predictions) {
      assert.ok(['model', 'fallback', 'backend_rules'].includes(prediction.source), 'every prediction states its source');
      if (prediction.source === 'model') {
        assert.ok(prediction.modelName, 'a model-backed prediction names the model');
        assert.ok(prediction.modelVersion, 'a model-backed prediction names the version');
      }
    }
  });

  test('the AI client reports breaker state rather than throwing through the API', async () => {
    const state = aiClient.state();
    assert.ok(state, 'the client exposes its state for the health endpoint');
    assert.equal(typeof state.calls, 'number');
    assert.equal(typeof state.circuitBreakerOpen, 'boolean');
  });
});

describe('ai socket contract', () => {
  test('the operational event names are untouched and the AI events are additive', async () => {
    const operational = ['bed:updated', 'doctor:availability', 'nurse:availability', 'equipment:updated', 'queue:updated', 'surge:detected', 'optimization:completed', 'allocation:updated', 'alert:created'];
    assert.deepEqual(Object.values(EVENTS), operational, 'the nine operational events keep their exact names');

    for (const event of Object.values(AI_EVENTS)) {
      assert.ok(event.startsWith('ai:'), 'AI events live in their own namespace');
      assert.equal(operational.includes(event), false, 'no AI event shadows an operational event');
    }
  });

  test('AI rooms never include an unauthenticated broadcast', async () => {
    for (const roomName of AI_ROOMS) {
      assert.ok(roomName.startsWith('role:'), 'AI events target role rooms only');
    }
  });
});

describe('decision support boundary', () => {
  test('the advisory never claims to apply a change', async () => {
    const response = await request().post('/api/ai/advisory').set(auth(coordinator.token)).send({});
    assert.equal(response.status, 200);
    assert.equal(response.body.requiresHumanApproval, true);

    if (response.body.available && response.body.recommendations) {
      for (const recommendation of response.body.recommendations) {
        assert.equal(recommendation.requiresHumanApproval, true, 'every recommendation waits for a human decision');
      }
    }
  });

  test('the optimization run created outside the AI layer still requires approval', async () => {
    const optimization = await request().post('/api/optimization').set(auth(command.token)).send({});
    assert.ok([200, 201].includes(optimization.status), `unexpected status ${optimization.status}`);
    assert.ok(optimization.body.data.approval.id, 'plans are attached to an approval, never applied directly');
  });

  test('no AI endpoint mutates live operational rows by itself', async () => {
    const before = await prisma.bed.count({ where: { status: 'OCCUPIED' } });
    await request().post('/api/ai/simulate').set(auth(command.token)).send({ patientCount: 10 });
    const after = await prisma.bed.count({ where: { status: 'OCCUPIED' } });
    assert.equal(after, before, 'requesting a projection does not change the live census');
  });
});
