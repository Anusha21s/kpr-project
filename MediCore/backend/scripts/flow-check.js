#!/usr/bin/env node
/**
 * End-to-end API flow check.
 *
 * Exercises the full demonstration path against a running API:
 *   login → command center overview → surge simulation → optimization →
 *   coordinator approval → transactional allocation → notifications →
 *   doctor "my patients" → nurse duty → alerts/OT/equipment reads.
 *
 * Usage: node scripts/flow-check.js [baseUrl]
 */

const BASE = process.argv[2] || process.env.API_BASE || 'http://127.0.0.1:4000/api';
const PASSWORDS = process.env.SEED_PASSWORD || 'demo123';

let passed = 0;
let failed = 0;

const call = async (path, { method = 'GET', token = null, body = null } = {}) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (error) {
    payload = text;
  }
  return { status: response.status, body: payload };
};

/** Mutations answer with `{success:true,data}`; reads answer with the payload. */
const payload = (body) => (body && body.data !== undefined ? body.data : body);

const check = (label, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const section = (title) => console.log(`\n${title}`);

(async () => {
  console.log(`MediCore API flow check → ${BASE}`);

  /* ------------------------------------------------------------- health */
  section('Health');
  const health = await call('/health');
  check('GET /api/health', health.status === 200 && health.body.status === 'ok', `database ${health.body.database.status}`);

  /* --------------------------------------------------------------- auth */
  section('Authentication');
  const badLogin = await call('/auth/login', { method: 'POST', body: { staffId: 'CMD001', password: 'wrong-password' } });
  check('invalid login rejected', badLogin.status === 401 && badLogin.body.error.code === 'UNAUTHORIZED', badLogin.body.error.message);

  const loggedOut = await call('/dashboard/overview');
  check('protected route without token → 401', loggedOut.status === 401);

  const login = async (staffId) => {
    const result = await call('/auth/login', { method: 'POST', body: { staffId, password: PASSWORDS } });
    if (result.status !== 200 || !result.body.token) throw new Error(`login failed for ${staffId}: ${JSON.stringify(result.body)}`);
    return result.body;
  };

  const command = await login('CMD001');
  const coordinator = await login('RES001');
  const doctor = await login('DOC001');
  const doctor2 = await login('DOC002');
  const nurse = await login('NUR001');
  check('roles come from the account', [command.user.role, coordinator.user.role, doctor.user.role, nurse.user.role].join(',') === 'command_center,resource_coordinator,doctor,nurse');

  const me = await call('/auth/me', { token: doctor.token });
  check('GET /api/auth/me', me.status === 200 && me.body.staffRef === 'DOC-1042', me.body.roleName);

  /* -------------------------------------------------- role authorization */
  section('Role authorization');
  const doctorSurge = await call('/simulation', { method: 'POST', token: doctor.token, body: { patientCount: 20 } });
  check('doctor cannot run a surge simulation', doctorSurge.status === 403, doctorSurge.body.error.code);

  const commandApprove = await call('/allocations/APR-0001/approve', { method: 'POST', token: command.token, body: {} });
  check('command center cannot approve allocations', commandApprove.status === 403, commandApprove.body.error.code);

  const invalidBody = await call('/simulation', { method: 'POST', token: command.token, body: { patientCount: 999 } });
  check('invalid payload → 400 validation envelope', invalidBody.status === 400 && invalidBody.body.error.code === 'VALIDATION_ERROR');

  /* ------------------------------------------------------------ overview */
  section('Command center overview');
  const overview = await call('/dashboard/overview', { token: command.token });
  const metrics = overview.body.metrics;
  check('GET /api/dashboard/overview', overview.status === 200 && metrics.beds.total === 100, `${metrics.beds.total} beds`);
  check('every number is computed from the database', metrics.beds.occupied + metrics.beds.reserved + metrics.beds.available <= metrics.beds.total, `${metrics.beds.committed} committed / ${metrics.beds.available} free`);
  check('pressure band present', typeof metrics.pressure.overall === 'number' && ['NORMAL', 'MODERATE', 'HIGH', 'CRITICAL'].includes(metrics.pressure.band), `${metrics.pressure.overall}% ${metrics.pressure.band}`);
  check('conflicts detected', Array.isArray(overview.body.conflicts) && overview.body.conflicts.length > 0, overview.body.conflicts.map((conflict) => conflict.id).join(' '));

  /* ------------------------------------------------------- staff scoping */
  section('Assignment scoping');
  const myPatients = await call('/patients/my', { token: doctor.token });
  check('GET /api/patients/my (doctor)', myPatients.status === 200 && myPatients.body.scope === 'own-assignments', `${myPatients.body.total} patient(s)`);
  const allPatients = await call('/patients', { token: command.token });
  check('command center sees the wider list', allPatients.status === 200 && allPatients.body.total >= myPatients.body.total, `${allPatients.body.total} rows`);
  const crossDoctor = await call('/patients/my', { token: doctor2.token });
  const leaked = crossDoctor.body.patients.some((patient) => !patient.assignedDoctors.includes(doctor2.user.staffRef));
  check('no cross-doctor leakage', leaked === false, `${crossDoctor.body.total} patient(s) for DOC002`);

  /* ---------------------------------------------------------- resources */
  section('Resource reads');
  const beds = await call('/beds', { token: command.token });
  check('GET /api/beds', beds.status === 200 && beds.body.wards.length === 4, beds.body.wards.map((ward) => `${ward.id}:${ward.occupancyPercentage}%`).join(' '));
  const queue = await call('/queue', { token: command.token });
  check('GET /api/queue', queue.status === 200 && queue.body.queue.length >= 8, `critical ${queue.body.demand.critical}`);
  const doctors = await call('/doctors', { token: command.token });
  check('GET /api/doctors', doctors.status === 200 && doctors.body.total === 30, `${doctors.body.summary.available} available of ${doctors.body.summary.onDuty} on duty`);
  const nurses = await call('/nurses', { token: command.token });
  check('GET /api/nurses', nurses.status === 200 && nurses.body.summary.atConstraint > 0, `${nurses.body.summary.atConstraint} at the workload constraint`);
  const equipment = await call('/equipment', { token: command.token });
  check('GET /api/equipment', equipment.status === 200 && equipment.body.summary.ventilators.total === 15, `${equipment.body.summary.ventilators.free} ventilators free`);
  const emergency = await call('/emergency-resources', { token: command.token });
  check('GET /api/emergency-resources', emergency.status === 200 && emergency.body.total === 5);
  const ot = await call('/ot', { token: command.token });
  check('GET /api/ot', ot.status === 200 && ot.body.theatreRooms.length === 4, `${ot.body.summary.active} active of ${ot.body.summary.total}`);
  const otConflicts = await call('/ot/conflicts', { token: command.token });
  check('GET /api/ot/conflicts', otConflicts.status === 200);

  /* --------------------------------------------------------- surge run */
  section('Surge simulation');
  const before = await call('/dashboard/kpis', { token: command.token });
  const surge = await call('/simulation', { method: 'POST', token: command.token, body: { scenario: 'MASS_CASUALTY_INTAKE', patientCount: 20 } });
  surge.body = payload(surge.body);
  check('POST /api/simulation', surge.status === 200 && surge.body.after.emergencyQueue > surge.body.before.emergencyQueue, `${surge.body.before.emergencyQueue} → ${surge.body.after.emergencyQueue} waiting`);
  check('before / after / changes / conflicts present', Boolean(surge.body.before && surge.body.after && surge.body.changes && surge.body.conflicts.length), `${surge.body.conflicts.length} conflicts`);
  check('surge alert raised', typeof surge.body.alert === 'string', surge.body.alert);
  const liveAfterSurge = await call('/beds', { token: command.token });
  const occupiedNow = liveAfterSurge.body.summary.occupied;
  check('live occupancy unchanged by the projection', occupiedNow === beds.body.summary.occupied, `${occupiedNow} occupied before and after`);
  const heldBeds = liveAfterSurge.body.beds.filter((bed) => bed.status === 'Reserved').length;
  check('provisional holds registered', heldBeds > 0, `${heldBeds} bed(s) reserved`);

  /* ------------------------------------------------------- optimization */
  section('Multi-resource optimization');
  const optimization = await call('/optimization', { method: 'POST', token: command.token, body: { selections: { 'REC-ICU-01': 'icu-option-a' } } });
  optimization.body = payload(optimization.body);
  check('POST /api/optimization', optimization.status === 200 && optimization.body.recommendations.length > 0, optimization.body.recommendations.map((entry) => entry.id).join(' '));
  check('recommendations explain themselves', optimization.body.recommendations.every((entry) => entry.reason && entry.detail.length), 'reason + detail on every row');
  check('conflicts reported with a severity', optimization.body.conflicts.every((conflict) => conflict.severity), optimization.body.conflicts.map((entry) => `${entry.id}:${entry.severity}`).join(' '));
  check('approval request raised for the coordinator', Boolean(optimization.body.approval && optimization.body.approval.id), optimization.body.approval && optimization.body.approval.id);
  const approvalId = optimization.body.approval.id;

  /* ------------------------------------------------------------ approval */
  section('Approval workflow');
  const approvals = await call('/allocations/approvals', { token: coordinator.token });
  check('GET /api/allocations/approvals', approvals.status === 200 && approvals.body.pending >= 1, `${approvals.body.pending} pending`);
  const approved = await call(`/allocations/${approvalId}/approve`, { method: 'POST', token: coordinator.token, body: { note: 'Approved for the surge response' } });
  approved.body = payload(approved.body);
  check('POST /api/allocations/:id/approve', approved.status === 200 && approved.body.approval.status === 'Approved', `${approved.body.applied.allocations} allocation(s)`);
  check('transaction applied placements', approved.body.applied.placements.length > 0, approved.body.applied.placements.map((entry) => `${entry.patientId}→${entry.bedId}`).join(' '));
  check('rollback-safe transactional flag', approved.body.transactional === true);

  const doubleApprove = await call(`/allocations/${approvalId}/approve`, { method: 'POST', token: coordinator.token, body: {} });
  check('second approval rejected', doubleApprove.status === 409, doubleApprove.body.error.code);

  /* ------------------------------------------------------- notifications */
  section('Notifications and alerts');
  const notifications = await call('/notifications', { token: coordinator.token });
  check('coordinator notifications persisted', notifications.status === 200 && notifications.body.notifications.length > 0, `${notifications.body.unread} unread`);
  const doctorNotifications = await call('/notifications', { token: doctor.token });
  const leakedNotification = doctorNotifications.body.notifications.some((entry) => entry.title.includes('approval request'));
  check('coordinator-only notifications not visible to a doctor', leakedNotification === false, `${doctorNotifications.body.total} row(s)`);
  const alerts = await call('/alerts', { token: command.token });
  check('GET /api/alerts', alerts.status === 200 && alerts.body.alerts.length > 0, `${alerts.body.alerts.length} alerts`);
  const acknowledgement = await call(`/alerts/${alerts.body.alerts[0].dbId}/acknowledge`, { method: 'POST', token: command.token });
  check('alert acknowledgement', acknowledgement.status === 200 && acknowledgement.body.data.status === 'Acknowledged');

  /* ------------------------------------------------------------ clinical */
  section('Clinical view');
  const placed = approved.body.applied.placements;
  check('every placed patient has a responsible care team', placed.every((entry) => entry.careTeam && entry.careTeam.doctorId), placed.map((entry) => `${entry.patientId}:${entry.careTeam.doctorId}`).join(' '));

  /* The doctor accounts on the demo roster must receive the patients they were
     given — this is the "notification → My Patients" path from the brief. */
  const clinicalAccounts = ['DOC001', 'DOC002', 'DOC003', 'DOC004', 'DOC005'];
  let receivingDoctor = null;
  for (const staffId of clinicalAccounts) {
    const session = await login(staffId);
    const inbox = await call('/notifications', { token: session.token });
    if (inbox.body.notifications.some((entry) => /assigned to you|New assignment|Nursing assignment/i.test(entry.title))) {
      receivingDoctor = session;
      break;
    }
  }
  check('a receiving doctor was notified', Boolean(receivingDoctor), receivingDoctor ? receivingDoctor.user.name : 'no clinical account notified');

  if (receivingDoctor) {
    const inbox = await call('/notifications', { token: receivingDoctor.token });
    const assignmentNotice = inbox.body.notifications.find((entry) => /assigned to you|New assignment/i.test(entry.title));
    const myList = await call('/patients/my', { token: receivingDoctor.token });
    check('notified doctor sees the patient in My Patients', myList.body.patients.length > 0, `${receivingDoctor.user.staffRef} · ${myList.body.patients.length} patient(s)`);
    check('the notification carries the placement detail', Boolean(assignmentNotice && assignmentNotice.body), assignmentNotice ? assignmentNotice.title : '');
    check('My Patients is scoped to the signed-in doctor', myList.body.patients.every((patient) => patient.assignedDoctors.includes(receivingDoctor.user.staffRef)));
  }

  const nurseInbox = await call('/notifications', { token: nurse.token });
  check('nurse assignment notifications are persisted', Array.isArray(nurseInbox.body.notifications));
  const queueAfter = await call('/queue', { token: command.token });
  check(
    'queue reflects the placements',
    queueAfter.body.queue.length < surge.body.after.emergencyQueue,
    `${surge.body.after.emergencyQueue} after the surge → ${queueAfter.body.queue.length} waiting after approval`,
  );
  const tasks = await call('/tasks', { token: nurse.token });
  check('GET /api/tasks (nurse)', tasks.status === 200 && tasks.body.scope === 'own-assignments', `${tasks.body.open} open of ${tasks.body.total}`);
  const duty = await call('/nurses/me/duty', { token: nurse.token });
  check('GET /api/nurses/me/duty', duty.status === 200 && duty.body.staff.id === nurse.user.staffRef, `${duty.body.shift.label}`);

  /* ------------------------------------------------------------- revert */
  section('Reversibility');
  const reverted = await call('/simulation/revert', { method: 'POST', token: command.token });
  reverted.body = payload(reverted.body);
  check('POST /api/simulation/revert', reverted.status === 200 && reverted.body.reverted === true, `${reverted.body.removedPatients} simulated patient(s) removed`);

  /* ------------------------------------------------------------- finish */
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(`\nflow check crashed: ${error.message}`);
  process.exit(1);
});
