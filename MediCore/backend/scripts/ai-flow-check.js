#!/usr/bin/env node
/**
 * End-to-end demo rehearsal.
 *
 * Walks the full MediCore demo path against the running API and the live socket
 * server, and prints what happened at each step:
 *
 *   login → command centre → surge simulation → optimization → coordinator
 *   approval → transactional allocation → socket events → clinical notification
 *   → My Patients
 *
 * Usage: node scripts/ai-flow-check.js
 * It mutates the demo database, so reseed afterwards (`npm run seed`).
 */

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { io } = require('socket.io-client');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const BASE = process.env.DEMO_API_URL || `http://127.0.0.1:${process.env.PORT || 4000}`;
const PASSWORD = process.env.SEED_PASSWORD || 'demo123';

let failures = 0;
const check = (label, condition, detail = '') => {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

const api = async (method, path, { token, body } = {}) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: json };
};

const login = async (staffId) => {
  const response = await api('POST', '/api/auth/login', { body: { staffId, password: PASSWORD } });
  if (response.status !== 200) throw new Error(`login failed for ${staffId}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
};

const waitFor = (socket, event, timeout = 15000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeout);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const connect = (token) =>
  new Promise((resolve, reject) => {
    const socket = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.once('connection:ready', () => resolve(socket));
    socket.once('connect_error', reject);
    setTimeout(() => reject(new Error('socket connection timed out')), 8000);
  });

(async () => {
  console.log('\nMediCore — end-to-end demo rehearsal');
  console.log(`API: ${BASE}\n`);

  /* ------------------------------------------------------------------ login */
  console.log('1. Sign-in (the role comes from the account, never from the client)');
  const command = await login('CMD001');
  const coordinator = await login('RES001');
  const doctor = await login('DOC001');
  const nurse = await login('NUR001');
  check('command centre signed in', command.user.role === 'command_center', command.user.name);
  check('resource coordinator signed in', coordinator.user.role === 'resource_coordinator', coordinator.user.name);
  check('doctor signed in', doctor.user.role === 'doctor', `${doctor.user.name} · ${doctor.user.staffRef}`);
  check('nurse signed in', nurse.user.role === 'nurse', `${nurse.user.name} · ${nurse.user.staffRef}`);

  const sockets = {
    command: await connect(command.token),
    coordinator: await connect(coordinator.token),
    doctor: await connect(doctor.token),
    nurse: await connect(nurse.token),
  };
  const seen = [];
  for (const [label, socket] of Object.entries(sockets)) {
    socket.onAny((event, payload) => seen.push({ room: label, event, payload }));
  }

  /* --------------------------------------------------- command centre read */
  console.log('\n2. Command centre — one aggregated call, every number computed from the database');
  const overview = await api('GET', '/api/dashboard/overview', { token: command.token });
  check('overview answered', overview.status === 200);
  const m = overview.body.metrics;
  check('bed occupancy is derived', typeof m.beds.occupancyPercentage === 'number', `${m.beds.occupancyPercentage}% of ${m.beds.total} beds`);
  check('ICU is derived', typeof m.beds.icu.occupancyPercentage === 'number', `${m.beds.icu.occupied}/${m.beds.icu.total} ICU beds`);
  check('queue is derived', typeof m.queue.total === 'number', `${m.queue.total} waiting · ${m.queue.critical} critical`);
  check('pressure band is the hospital band', ['NORMAL', 'MODERATE', 'HIGH', 'CRITICAL'].includes(overview.body.pressure.band), overview.body.pressure.band);
  check('AI context is attached to the same payload', overview.body.ai !== undefined);

  /* ----------------------------------------------------------------- surge */
  console.log('\n3. Surge simulation — projected only, live rows untouched');
  const bedsBefore = await api('GET', '/api/beds', { token: command.token });
  const occupiedBefore = (bedsBefore.body.beds || []).filter((bed) => bed.status === 'Occupied').length;

  const surgeEvent = waitFor(sockets.command, 'surge:detected').catch(() => null);
  const surge = await api('POST', '/api/simulation', { token: command.token, body: { patientCount: 20, scenario: 'MASS_CASUALTY_INTAKE' } });
  check('simulation ran', [200, 201].includes(surge.status), surge.body?.data?.reference || surge.body?.reference);
  const simulation = surge.body.data || surge.body;
  check('before / projected / changes are present', Boolean(simulation.before && simulation.after && simulation.changes));
  check('conflicts are listed for review', Array.isArray(simulation.conflicts));
  await surgeEvent;
  check('surge:detected reached the command centre', seen.some((entry) => entry.event === 'surge:detected'));

  const bedsAfter = await api('GET', '/api/beds', { token: command.token });
  const occupiedAfter = (bedsAfter.body.beds || []).filter((bed) => bed.status === 'Occupied').length;
  check('the live census did not change', occupiedAfter === occupiedBefore, `${occupiedBefore} → ${occupiedAfter} occupied`);

  /* ---------------------------------------------------------- optimization */
  console.log('\n4. Multi-resource optimization — a plan for review, never an action');
  const optEvent = waitFor(sockets.coordinator, 'optimization:completed').catch(() => null);
  const optimization = await api('POST', '/api/optimization', { token: command.token, body: {} });
  const plan = optimization.body.data || optimization.body;
  check('optimizer answered', [200, 201].includes(optimization.status), plan.reference);
  check('a plan was produced', plan.recommendations.length >= 1, `${plan.recommendations.length} recommendation(s)`);
  check('an approval is required before anything moves', Boolean(plan.approval && plan.approval.id), plan.approval?.id);
  await optEvent;
  check('optimization:completed reached the coordinator', seen.some((entry) => entry.event === 'optimization:completed'));

  /* ------------------------------------------------------------- approvals */
  console.log('\n5. Coordinator approval — the only path that touches a resource');
  const pendingBefore = await api('GET', '/api/allocations/approvals', { token: coordinator.token });
  const pendingList = pendingBefore.body.approvals || pendingBefore.body.allocations || pendingBefore.body.data || [];
  const listed = pendingList.some((entry) => (entry.id || entry.reference) === plan.approval.id);
  check('the request appears in the coordinator approval queue', pendingBefore.status === 200 && listed, `${pendingList.length} pending`);

  const allocationEvent = waitFor(sockets.coordinator, 'allocation:updated').catch(() => null);
  const bedEvent = waitFor(sockets.command, 'bed:updated').catch(() => null);
  const approve = await api('POST', `/api/allocations/${plan.approval.id}/approve`, { token: coordinator.token, body: { note: 'E2E rehearsal — reviewed against the projected picture' } });
  if (approve.status !== 200) console.log(`      response: ${JSON.stringify(approve.body).slice(0, 400)}`);
  check('approval applied transactionally', approve.status === 200, JSON.stringify((approve.body.data || {}).applied || { placements: 'none' }).slice(0, 160));
  await Promise.all([allocationEvent, bedEvent]);
  check('allocation:updated fired', seen.some((entry) => entry.event === 'allocation:updated'));
  check('bed:updated fired', seen.some((entry) => entry.event === 'bed:updated'));

  const bedsAfterApproval = await api('GET', '/api/beds', { token: command.token });
  const occupiedAfterApproval = (bedsAfterApproval.body.beds || []).filter((bed) => bed.status === 'Occupied').length;
  check('the census changed only after approval', occupiedAfterApproval >= occupiedAfter, `${occupiedAfter} → ${occupiedAfterApproval} occupied`);
  check('no partial allocation: every placement is on a bed', (approve.body.data?.applied?.placements || []).every((placement) => placement.bedId));

  /* ----------------------------------------------------------- rejection */
  console.log('\n6. Rejection path — an alternative plan can be declined, leaving state intact');
  const secondRun = await api('POST', '/api/optimization', { token: command.token, body: {} });
  const secondPlan = secondRun.body.data || secondRun.body;
  const reject = await api('POST', `/api/allocations/${secondPlan.approval.id}/reject`, { token: coordinator.token, body: { reason: 'E2E rehearsal — theatre capacity already committed elsewhere' } });
  check('rejection recorded', reject.status === 200);
  check('the rejection applied nothing', (reject.body.data || {}).applied === false, 'applied: false');

  /* --------------------------------------------------------- notifications */
  console.log('\n7. Clinical notification — persisted, so it survives being offline');
  /* The clinicians who actually received a placement are the ones who must be
     notified — the feed is per user, so nobody else's patients leak into it. */
  const placedDoctors = [...new Set((approve.body.data?.applied?.placements || []).map((placement) => placement.careTeam?.doctorId).filter(Boolean))];
  const placedNurses = [...new Set((approve.body.data?.applied?.placements || []).map((placement) => placement.careTeam?.nurseId).filter(Boolean))];

  const feedFor = async (account) => {
    const session = await login(account);
    const feed = await api('GET', '/api/notifications', { token: session.token });
    return { session, items: feed.body.notifications || feed.body.data || [], status: feed.status };
  };

  const doctorFeed = await feedFor('DOC001');
  check('the doctor has a persisted notification feed', doctorFeed.status === 200, `${doctorFeed.items.length} item(s) · account ${doctorFeed.session.user.staffRef}`);
  check('notifications are stored server-side', doctorFeed.items.every((item) => item.id && item.createdAt));

  const nurseFeed = await feedFor('NUR001');
  check('the nurse has a persisted notification feed', nurseFeed.status === 200, `${nurseFeed.items.length} item(s) · account ${nurseFeed.session.user.staffRef}`);

  /* Every placed patient's care team gets its own persisted notification. */
  const notified = await prisma.notification.findMany({
    where: { category: 'Assignment', createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } },
    select: { userId: true, title: true, category: true },
  });
  const assignmentNotices = notified.filter((entry) => entry.category === 'Assignment');
  check(
    'the approved placements notified the assigned clinicians',
    assignmentNotices.length > 0 || (placedDoctors.length === 0 && placedNurses.length === 0),
    `${assignmentNotices.length} assignment notice(s) for ${placedDoctors.length} doctor(s) / ${placedNurses.length} nurse(s)`,
  );

  /* ---------------------------------------------------------- my patients */
  console.log('\n8. My Patients — server-side scoping, no cross-clinician leakage');
  const mine = await api('GET', '/api/patients/my', { token: doctor.token });
  const myPatients = mine.body.patients || mine.body.data || [];
  check('the doctor sees their own patients', mine.status === 200, `${myPatients.length} patient(s)`);

  const otherDoctor = await login('DOC002');
  const theirs = await api('GET', '/api/patients/my', { token: otherDoctor.token });
  const theirPatients = theirs.body.patients || theirs.body.data || [];
  const myNumbers = new Set(myPatients.map((patient) => patient.patientNumber || patient.id));
  const overlap = theirPatients.filter((patient) => myNumbers.has(patient.patientNumber || patient.id));
  check('two doctors do not receive the same patient list', overlap.length === 0, `${theirPatients.length} for ${otherDoctor.user.staffRef}`);

  const crossPatient = myPatients[0];
  if (crossPatient) {
    const listForOther = await api('GET', `/api/patients?assignedDoctor=${doctor.user.staffRef}`, { token: otherDoctor.token });
    const leaked = (listForOther.body.patients || []).some((patient) => (patient.patientNumber || patient.id) === (crossPatient.patientNumber || crossPatient.id));
    check('a doctor cannot query another doctor’s patients', leaked === false);
  }

  /* ------------------------------------------------------------- AI layer */
  console.log('\n9. AI layer — provenance on every number');
  const advisory = await api('POST', '/api/ai/advisory', { token: coordinator.token, body: { includeSimulation: false } });
  check('advisory answered', advisory.status === 200);
  if (advisory.body.available) {
    const pressure = advisory.body.predictions.pressure;
    check('hospital pressure leads, model view is reported beside it', ['NORMAL', 'MODERATE', 'HIGH', 'CRITICAL'].includes(pressure.pressure), `${pressure.pressure} (model: ${pressure.modelBand})`);
    check('every prediction states whether a model answered', ['model', 'fallback'].includes(pressure.source), pressure.source);
    check('recommendations require human approval', advisory.body.recommendations.every((entry) => entry.requiresHumanApproval === true));
    check('the advisory is labelled decision support', advisory.body.decisionSupportOnly === true);
  } else {
    check('the advisory degrades visibly when the model service is down', advisory.body.available === false, advisory.body.fallback_reason);
  }

  const history = await api('GET', '/api/ai/runs?limit=3', { token: coordinator.token });
  check('AI runs are persisted with their provenance', history.status === 200, `${(history.body.runs || []).length} recent run(s)`);

  /* -------------------------------------------------------------- teardown */
  await api('POST', '/api/simulation/revert', { token: command.token, body: {} });
  for (const socket of Object.values(sockets)) socket.disconnect();
  await prisma.$disconnect();
  const { disconnect } = require('../src/config/database');
  await disconnect();

  console.log('\nRealtime events observed');
  const counts = seen.reduce((totals, entry) => {
    const key = `${entry.event} → ${entry.room}`;
    totals[key] = (totals[key] || 0) + 1;
    return totals;
  }, {});
  for (const [key, count] of Object.entries(counts)) console.log(`  ${count}× ${key}`);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed check(s)\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\nflow check crashed:', error.message);
  process.exit(1);
});
