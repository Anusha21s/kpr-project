#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Contract sweep.
 *
 * Every endpoint in the API contract is called once for every role that is
 * allowed to call it, and once for a role that is not. The sweep prints a
 * result table and exits non-zero if an endpoint answers with a status that
 * has not been agreed in the acceptance criteria.
 *
 * Usage: node scripts/route-sweep.js [http://localhost:4000/api]
 */

const BASE = process.argv[2] || process.env.API_BASE_URL || 'http://localhost:4000/api';
const PASSWORD = 'demo123';

const accounts = {
  command_center: 'CMD001',
  resource_coordinator: 'RES001',
  doctor: 'DOC001',
  doctor2: 'DOC002',
  nurse: 'NUR001',
  nurse2: 'NUR004',
};

const results = [];
let context = {};

const call = async (method, path, { token, body, role, expect = [200], note } = {}) => {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => null);
  const ok = expect.includes(response.status);
  results.push({
    ok,
    role: role || '—',
    method,
    path,
    status: response.status,
    expected: expect.join('/'),
    note: ok ? '' : (payload && payload.error && payload.error.message) || note || '',
  });
  return { status: response.status, body: payload };
};

const token = {};
const login = async (key) => {
  const response = await call('POST', '/auth/login', {
    body: { staffId: accounts[key], password: PASSWORD },
    role: accounts[key],
    expect: [200],
  });
  token[key] = response.body.token;
};

(async () => {
  console.log(`\nMediCore contract sweep → ${BASE}\n${'─'.repeat(96)}`);

  await call('GET', '/health', { expect: [200] });
  /* `/` serves the live operational status page; an unknown API path is 404. */
  await call('GET', '/no-such-endpoint', { expect: [404] });

  await login('command_center');
  await login('resource_coordinator');
  await login('doctor');
  await login('doctor2');
  await login('nurse');

  /* ── authenticated reads for every role ─────────────────────────────── */
  const readPaths = [
    '/dashboard/overview',
    '/dashboard/kpis',
    '/dashboard/activity',
    '/patients',
    '/patients/my',
    '/queue',
    '/beds',
    '/beds/wards',
    '/doctors',
    '/nurses',
    '/staff/roster',
    '/equipment',
    '/emergency-resources',
    '/ot',
    '/ot/conflicts',
    '/simulation',
    '/optimization',
    '/optimization/conflicts',
    '/allocations',
    '/alerts',
    '/notifications',
  ];

  for (const role of ['command_center', 'resource_coordinator', 'doctor', 'nurse']) {
    for (const path of readPaths) {
      await call('GET', path, { token: token[role], role });
    }
  }

  /* ── a detail read has to survive a real identifier ─────────────────── */
  const overview = await call('GET', '/dashboard/overview', { token: token.command_center, role: 'CMD001' });
  const anyPatient = overview.body.patients[0];
  const anyBed = overview.body.bedUnits.find((bed) => bed.status === 'Available');
  const anyQueue = overview.body.queue[0];
  /* clinicalTasks arrives keyed by task id (the shape the dashboards use). */
  const tasks = Object.values(overview.body.clinicalTasks || {});
  const anyTask = tasks.find((task) => task.status !== 'Completed');

  await call('GET', `/patients/${anyPatient.id}`, { token: token.command_center, role: 'CMD001' });
  await call('GET', '/patients/DOES-NOT-EXIST', { token: token.command_center, role: 'CMD001', expect: [404] });

  /* ── role walls ─────────────────────────────────────────────────────── */
  await call('POST', '/simulation', { token: token.doctor, role: 'DOC001', body: { patientCount: 8 }, expect: [403] });
  await call('POST', '/simulation', { token: token.resource_coordinator, role: 'RES001', body: { patientCount: 0 }, expect: [400] });
  await call('POST', '/allocations/APR-NOPE/approve', { token: token.command_center, role: 'CMD001', body: {}, expect: [403] });
  await call('PATCH', `/beds/${anyBed.id}/status`, { token: token.doctor, role: 'DOC001', body: { status: 'Available' }, expect: [403] });
  await call('POST', '/equipment/reserve', { token: token.nurse, role: 'NUR001', body: { categoryId: 'ventilators', quantity: 1 }, expect: [403] });
  await call('GET', '/audit', { token: token.doctor, role: 'DOC001', expect: [403] });
  await call('GET', '/dashboard/overview', { token: undefined, role: 'anonymous', expect: [401] });
  await call('POST', '/simulation', { token: token.command_center, role: 'CMD001', body: { patientCount: 'many' }, expect: [400] });
  await call('GET', '/beds?status=NotAStatus', { token: token.command_center, role: 'CMD001', expect: [400] });

  /* ── clinical duty + tasks ──────────────────────────────────────────── */
  await call('GET', '/doctors/me/duty', { token: token.doctor, role: 'DOC001' });
  await call('GET', '/nurses/me/duty', { token: token.nurse, role: 'NUR001' });
  await call('GET', '/doctors/me/duty', { token: token.command_center, role: 'CMD001', expect: [403] });
  if (anyTask) {
    await call('POST', `/tasks/${anyTask.id}/note`, { token: token.command_center, role: 'CMD001', body: { note: 'Sweep note' } });
  }
  await call('GET', '/tasks', { token: token.nurse, role: 'NUR001' });

  /* ── bed lifecycle on a free bed, restored afterwards ───────────────── */
  await call('PATCH', `/beds/${anyBed.id}/status`, { token: token.resource_coordinator, role: 'RES001', body: { status: 'Reserved', heldFor: 'Sweep hold' } });
  await call('PATCH', `/beds/${anyBed.id}/status`, { token: token.resource_coordinator, role: 'RES001', body: { status: 'Available' } });
  await call('POST', `/beds/${anyBed.id}/assign`, { token: token.resource_coordinator, role: 'RES001', body: { patientId: anyQueue.patientId || anyQueue.id, note: 'Sweep placement' } });
  await call('POST', `/beds/${anyBed.id}/release`, { token: token.resource_coordinator, role: 'RES001', body: { reason: 'Sweep release — returned to cleaning' } });

  /* ── equipment round trip ───────────────────────────────────────────── */
  const equipment = await call('GET', '/equipment', { token: token.resource_coordinator, role: 'RES001' });
  const spare = equipment.body.categories.find((category) => category.free >= 1);
  const reserved = await call('POST', '/equipment/reserve', {
    token: token.resource_coordinator,
    role: 'RES001',
    body: { categoryId: spare.id, quantity: 1, reservedFor: 'Sweep reservation' },
  });
  await call('POST', '/equipment/release', {
    token: token.resource_coordinator,
    role: 'RES001',
    body: { categoryId: spare.id, unitIds: reserved.body.data.unitIds, reason: 'Sweep release' },
  });
  await call('POST', '/equipment/reserve', {
    token: token.resource_coordinator,
    role: 'RES001',
    body: { categoryId: spare.id, quantity: 999, reservedFor: 'Sweep over-commit' },
    expect: [409, 400],
  });

  /* ── staffing round trip ────────────────────────────────────────────── */
  await call('PATCH', '/doctors/DOC-1201/duty', { token: token.resource_coordinator, role: 'RES001', body: { dutyStatus: 'OFF_DUTY', rationale: 'Sweep' } });
  await call('PATCH', '/doctors/DOC-1201/duty', { token: token.resource_coordinator, role: 'RES001', body: { dutyStatus: 'ON_DUTY', availability: 'Available' } });
  await call('PATCH', '/doctors/DOC-1201/duty', { token: token.resource_coordinator, role: 'RES001', body: { dutyStatus: 'HOLIDAY' }, expect: [400] });
  await call('PATCH', '/nurses/NUR-204/duty', { token: token.resource_coordinator, role: 'RES001', body: { dutyStatus: 'ON_DUTY', availability: 'Available' } });

  /* ── queue intake + theatre round trip ──────────────────────────────── */
  const intake = await call('POST', '/queue', {
    token: token.command_center,
    role: 'CMD001',
    body: { patientNumber: `P9${Math.floor(Math.random() * 899 + 100)}`, priority: 'High', requiredResource: 'General Bed', reason: 'Sweep intake' },
    expect: [200, 201],
  });
  if (intake.status === 200) {
    const queueId = intake.body.data.id;
    const secure = await call('POST', `/queue/${queueId}/secure`, {
      token: token.resource_coordinator,
      role: 'RES001',
      body: { resource: 'Ambulance' },
      expect: [200, 400, 404],
    });
    if (secure.status === 200) {
      await call('POST', `/queue/${queueId}/secure`, { token: token.resource_coordinator, role: 'RES001', body: { resource: null } });
    }
  }
  const theatreshold = await call('POST', '/ot/OT-03/hold', {
    token: token.resource_coordinator,
    role: 'RES001',
    body: { patientId: anyQueue.patientId || anyQueue.id, reason: 'Sweep hold for emergency surgical review' },
  });
  if (theatreshold.status === 200) {
    await call('POST', '/ot/OT-03/release', { token: token.resource_coordinator, role: 'RES001', body: { reason: 'Sweep release' } });
  }
  await call('POST', '/ot/OT-04/hold', { token: token.resource_coordinator, role: 'RES001', body: { reason: 'Sweep on maintained theatre' }, expect: [409, 400] });
  await call('POST', '/emergency-resources/reinforce', {
    token: token.resource_coordinator,
    role: 'RES001',
    body: { resourceId: 'trauma', action: 'hold', quantity: 1, note: 'Sweep reinforcement' },
    expect: [200, 404, 400],
  });

  /* ── alerts + notifications ─────────────────────────────────────────── */
  const alerts = await call('GET', '/alerts', { token: token.command_center, role: 'CMD001' });
  const activeAlert = alerts.body.alerts.find((alert) => alert.status !== 'Resolved');
  if (activeAlert) {
    await call('POST', `/alerts/${activeAlert.id}/acknowledge`, { token: token.command_center, role: 'CMD001' });
    await call('POST', `/alerts/${activeAlert.id}/resolve`, { token: token.command_center, role: 'CMD001' });
  }
  await call('POST', '/alerts/sync', { token: token.command_center, role: 'CMD001' });
  await call('POST', '/alerts/acknowledge-all', { token: token.resource_coordinator, role: 'RES001' });
  const inbox = await call('GET', '/notifications', { token: token.doctor, role: 'DOC001' });
  const unread = inbox.body.notifications.find((entry) => !entry.read);
  if (unread) {
    await call('POST', `/notifications/${unread.id}/read`, { token: token.doctor, role: 'DOC001' });
    await call('POST', `/notifications/${unread.id}/read`, { token: token.doctor2, role: 'DOC002', expect: [404] });
  }
  await call('POST', '/notifications/read-all', { token: token.doctor, role: 'DOC001' });

  /* ── surge → optimize → approve → revert ────────────────────────────── */
  const surge = await call('POST', '/simulation', { token: token.command_center, role: 'CMD001', body: { patientCount: 14, offset: 12 } });
  context.simulationId = surge.body.data && surge.body.data.id;
  await call('GET', `/simulation`, { token: token.resource_coordinator, role: 'RES001' });
  const optimization = await call('POST', '/optimization', { token: token.command_center, role: 'CMD001', body: {} });
  const approvalId = optimization.body.data.approval.id;
  await call('POST', `/allocations/${approvalId}/approve`, { token: token.command_center, role: 'CMD001', body: {}, expect: [403] });
  await call('POST', `/allocations/${approvalId}/approve`, { token: token.resource_coordinator, role: 'RES001', body: { note: 'Sweep approval' } });
  await call('GET', '/allocations', { token: token.resource_coordinator, role: 'RES001' });
  await call('GET', '/allocations?status=CONFIRMED', { token: token.command_center, role: 'CMD001' });
  await call('GET', '/allocations/approvals', { token: token.command_center, role: 'CMD001' });

  const second = await call('POST', '/optimization', { token: token.command_center, role: 'CMD001', body: {} });
  await call('POST', `/allocations/${second.body.data.approval.id}/reject`, {
    token: token.resource_coordinator,
    role: 'RES001',
    body: { reason: 'Sweep rejection — the plan is not confirmed against the current picture.' },
  });

  /* ── HE-02 AI layer ─────────────────────────────────────────────────── */
  await call('GET', '/ai/health', { token: token.command_center, role: 'CMD001' });
  await call('GET', '/ai/health', { token: token.doctor, role: 'DOC001' });
  await call('GET', '/ai/models', { token: token.command_center, role: 'CMD001' });
  await call('POST', '/ai/models', { token: token.command_center, role: 'CMD001', expect: [404] });
  await call('GET', '/ai/models', { token: token.doctor, role: 'DOC001', expect: [403] });
  await call('GET', '/ai/runs?limit=5', { token: token.resource_coordinator, role: 'RES001' });
  await call('GET', '/ai/runs', { token: token.nurse, role: 'NUR001', expect: [403] });
  await call('GET', '/ai/predictions?target=pressure&limit=5', { token: token.command_center, role: 'CMD001' });
  await call('GET', '/ai/runs?limit=999', { token: token.command_center, role: 'CMD001', expect: [400] });

  await call('POST', '/ai/demand/forecast', { token: token.command_center, role: 'CMD001', body: {} });
  await call('POST', '/ai/resources/forecast', { token: token.resource_coordinator, role: 'RES001', body: {} });
  await call('POST', '/ai/pressure/predict', { token: token.command_center, role: 'CMD001', body: {} });
  await call('POST', '/ai/surge/detect', { token: token.command_center, role: 'CMD001', body: {} });
  await call('POST', '/ai/doctor-workload/predict', { token: token.doctor, role: 'DOC001', body: {} });
  await call('POST', '/ai/doctor-workload/predict', { token: token.resource_coordinator, role: 'RES001', body: {} });
  await call('POST', '/ai/nurse-workload/predict', { token: token.nurse, role: 'NUR001', body: {} });
  await call('POST', '/ai/equipment-demand/predict', { token: token.resource_coordinator, role: 'RES001', body: {} });
  await call('POST', '/ai/patient-flow/predict', { token: token.command_center, role: 'CMD001', body: {} });

  const advisory = await call('POST', '/ai/advisory', {
    token: token.resource_coordinator,
    role: 'RES001',
    body: { includeSimulation: false },
  });
  if (advisory.body && advisory.body.available) {
    /* The advisory must carry provenance, never a bare number. */
    if (!advisory.body.predictions || !advisory.body.predictions.pressure.source) {
      results.push({ ok: false, role: 'RES001', method: 'POST', path: '/ai/advisory', status: advisory.status, expected: 'provenance', note: 'the advisory did not state whether a model answered' });
    }
  }
  await call('POST', '/ai/advisory', { token: token.doctor, role: 'DOC001', expect: [403] });
  await call('POST', '/ai/advisory', { token: token.command_center, role: 'CMD001', body: { surgePatientCount: 500 }, expect: [400] });

  await call('POST', '/ai/simulate', { token: token.command_center, role: 'CMD001', body: { patientCount: 12, scenario: 'MASS_CASUALTY_INTAKE' } });
  await call('POST', '/ai/simulate', { token: token.nurse, role: 'NUR001', body: { patientCount: 12 }, expect: [403] });
  await call('POST', '/ai/simulate', { token: token.command_center, role: 'CMD001', body: { patientCount: 0 }, expect: [400] });

  /* Unauthenticated access is refused on every AI route. */
  await call('POST', '/ai/advisory', { body: {}, expect: [401] });
  await call('GET', '/ai/models', { expect: [401] });

  await call('POST', '/simulation/revert', { token: token.command_center, role: 'CMD001' });

  /* ── report ─────────────────────────────────────────────────────────── */
  const failed = results.filter((entry) => !entry.ok);
  const byPath = new Map();
  results.forEach((entry) => {
    const key = `${entry.method} ${entry.path.split('?')[0].replace(/\/cm[a-z0-9]+/, '/:id')}`;
    if (!byPath.has(key)) byPath.set(key, entry);
  });

  console.log(`${'─'.repeat(96)}`);
  byPath.forEach((entry) => {
    const mark = entry.ok ? '✓' : '✗';
    console.log(`${mark} ${entry.method.padEnd(6)} ${entry.path.padEnd(48)} ${String(entry.status).padEnd(4)} [${entry.role}]`);
    if (!entry.ok) console.log(`    expected ${entry.expected} — ${entry.note}`);
  });

  console.log(`${'─'.repeat(96)}`);
  failed.forEach((entry) => console.log(`✗ ${entry.method} ${entry.path} → ${entry.status} (expected ${entry.expected}) [${entry.role}] ${entry.note}`));
  console.log(`${results.length - failed.length} passed, ${failed.length} failed of ${results.length} calls`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error('sweep crashed:', error.message);
  if (process.env.SWEEP_DEBUG) console.error(error.stack);
  process.exit(1);
});
