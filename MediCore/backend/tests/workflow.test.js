/**
 * Surge → optimization → approval → transactional allocation (§23–32, §38).
 *
 * The suite runs against the isolated test database and always ends by
 * reverting its own surge projection, so it can be re-run.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { request, login, auth, prisma, disconnect } = require('./helpers');

let command;
let coordinator;
let doctor;

before(async () => {
  [command, coordinator, doctor] = await Promise.all([login('CMD001'), login('RES001'), login('DOC001')]);
});

after(async () => {
  await prisma.patientQueue.deleteMany({ where: { patient: { isSimulated: true } } });
  await prisma.patient.deleteMany({ where: { isSimulated: true } });
  await prisma.surgeSimulation.updateMany({ where: { active: true }, data: { active: false, status: 'REVERTED', revertedAt: new Date() } });
  await prisma.bed.updateMany({ where: { heldFor: { contains: 'Simulation' } }, data: { status: 'AVAILABLE', heldFor: null, availableFrom: null } });
  await disconnect();
});

describe('surge simulation', () => {
  test('the projection changes the operational picture without touching live occupancy', async () => {
    const before = await request().get('/api/beds').set(auth(command.token));
    const baseline = before.body.summary;

    const surge = await request()
      .post('/api/simulation')
      .set(auth(command.token))
      .send({ scenario: 'MASS_CASUALTY_INTAKE', patientCount: 20 });
    assert.equal(surge.status, 200);

    const payload = surge.body.data;
    assert.ok(payload.after.emergencyQueue > payload.before.emergencyQueue, 'the emergency queue grows');
    assert.ok(payload.conflicts.length > 0, 'the intake creates conflicts');
    assert.ok(payload.changes && payload.changes.queue && payload.changes.icu, 'before/after changes are reported');
    assert.match(payload.note, /not modified|projection/i);

    const after = await request().get('/api/beds').set(auth(command.token));
    assert.equal(after.body.summary.occupied, baseline.occupied, 'live occupancy is unchanged by the projection');
    assert.equal(after.body.summary.total, baseline.total);

    const simulated = await prisma.patient.count({ where: { isSimulated: true } });
    assert.equal(simulated, payload.patientCount, 'the intake is stored as simulation-scoped rows');
  });

  test('reverting a simulation removes the projected patients', async () => {
    const reverted = await request().post('/api/simulation/revert').set(auth(command.token)).send({});
    assert.equal(reverted.status, 200);
    assert.equal(reverted.body.data.reverted, true);
    const remaining = await prisma.patient.count({ where: { isSimulated: true } });
    assert.equal(remaining, 0);
  });
});

describe('multi-resource optimization', () => {
  test('recommendations cover every resource group and explain themselves', async () => {
    await request().post('/api/simulation').set(auth(command.token)).send({ patientCount: 20 });
    const response = await request()
      .post('/api/optimization')
      .set(auth(command.token))
      .send({ selections: { 'REC-ICU-01': 'icu-option-a' } });

    assert.equal(response.status, 200);
    const data = response.body.data;
    const ids = data.recommendations.map((entry) => entry.id);
    ['REC-BED-01', 'REC-ICU-01', 'REC-NUR-01'].forEach((id) => assert.ok(ids.includes(id), `${id} is part of the recommendation set`));
    assert.ok(data.recommendations.every((entry) => entry.reason && entry.detail.length), 'every recommendation carries a reason');
    assert.ok(data.conflicts.every((conflict) => conflict.severity), 'every conflict carries a severity');
    assert.equal(data.decisionSupportOnly, true);
    assert.match(data.note, /decision support/i);
    assert.ok(data.approval && data.approval.id, 'an approval request is raised for the coordinator');
  });

  test('constraints report resource, capacity, demand, gap and affected patients', async () => {
    const response = await request().get('/api/optimization/conflicts').set(auth(command.token));
    assert.equal(response.status, 200);
    const capacityConflict = response.body.conflicts.find((conflict) => conflict.type === 'CAPACITY_SHORTFALL');
    assert.ok(capacityConflict, 'a capacity shortfall is detected');
    ['resource', 'capacity', 'demand', 'gap', 'severity', 'affectedPatients'].forEach((field) =>
      assert.ok(field in capacityConflict, `the conflict reports ${field}`),
    );
  });

  test('the multi-resource case is treated as one coordination problem', async () => {
    const response = await request().get('/api/optimization/conflicts').set(auth(command.token));
    const multi = response.body.conflicts.find((conflict) => conflict.id === 'CFL-01');
    assert.ok(multi, 'the multi-resource conflict is raised');
    assert.equal(multi.severity, 'Critical');
    assert.ok(multi.resources.length >= 5, 'ICU, theatre, specialist, nursing and ventilator rows are present');
    assert.match(multi.principleNote, /does not cancel|does not .*automatically|review actions/i);
  });

  test('off-duty doctors are never proposed', async () => {
    const offDuty = await prisma.doctor.findFirst({ where: { dutyStatus: 'OFF_DUTY' } });
    const response = await request().post('/api/optimization').set(auth(command.token)).send({});
    const assignments = response.body.data.recommendations
      .filter((entry) => entry.id === 'REC-DOC-01')
      .flatMap((entry) => (entry.detail || []).join(' '));
    assert.equal(String(assignments).includes(offDuty.name), false, `${offDuty.name} stays out of the proposal`);
  });
});

describe('approval workflow and transactional allocation', () => {
  let approvalId;

  test('the coordinator receives a pending approval', async () => {
    const response = await request().post('/api/optimization').set(auth(command.token)).send({});
    approvalId = response.body.data.approval.id;
    assert.ok(approvalId);

    const approvals = await request().get('/api/allocations/approvals').set(auth(coordinator.token));
    assert.equal(approvals.status, 200);
    assert.ok(approvals.body.approvals.some((approval) => approval.id === approvalId && approval.status === 'Pending Review'));
  });

  test('approving applies every allocation in one transaction', async () => {
    const before = await prisma.bed.count({ where: { patientId: { not: null } } });
    const response = await request()
      .post(`/api/allocations/${approvalId}/approve`)
      .set(auth(coordinator.token))
      .send({ note: 'Approved for the surge response' });

    assert.equal(response.status, 200);
    const applied = response.body.data.applied;
    assert.ok(applied.placements.length > 0, 'patients were placed');
    assert.equal(response.body.data.transactional, true);
    assert.ok(applied.placements.every((placement) => placement.careTeam.doctorId), 'every placement has a responsible doctor');

    const after = await prisma.bed.count({ where: { patientId: { not: null } } });
    assert.equal(after, before + applied.placements.length);

    const queues = await prisma.patientQueue.findMany({ where: { patient: { patientNumber: { in: applied.placements.map((placement) => placement.patientId) } } } });
    assert.ok(queues.every((entry) => entry.status === 'ALLOCATED'), 'placed patients left the queue');
  });

  test('an approval can only be decided once', async () => {
    const response = await request().post(`/api/allocations/${approvalId}/approve`).set(auth(coordinator.token)).send({});
    assert.equal(response.status, 409);
  });

  test('rejecting an approval applies nothing', async () => {
    const optimization = await request().post('/api/optimization').set(auth(command.token)).send({});
    const rejectId = optimization.body.data.approval.id;

    const bedsBefore = await prisma.bed.count({ where: { patientId: { not: null } } });
    const response = await request()
      .post(`/api/allocations/${rejectId}/reject`)
      .set(auth(coordinator.token))
      .send({ reason: 'Escalating to the duty intensivist instead' });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.applied, false);
    assert.equal(response.body.data.allocations, 0);

    const bedsAfter = await prisma.bed.count({ where: { patientId: { not: null } } });
    assert.equal(bedsAfter, bedsBefore, 'no bed changed hands on a rejection');

    const stored = await prisma.approval.findFirst({ where: { reference: rejectId } });
    assert.equal(stored.status, 'REJECTED');
    const staged = await prisma.allocation.findMany({ where: { approvalId: stored.id } });
    assert.ok(staged.every((allocation) => allocation.status === 'REJECTED'));
  });

  test('two coordinators approving at the same time cannot apply the plan twice', async () => {
    const optimization = await request().post('/api/optimization').set(auth(command.token)).send({});
    const approval = optimization.body.data.approval.id;

    const bedsBefore = await prisma.bed.count({ where: { patientId: { not: null } } });
    const [first, second] = await Promise.all([
      request().post(`/api/allocations/${approval}/approve`).set(auth(coordinator.token)).send({ note: 'Concurrent approval A' }),
      request().post(`/api/allocations/${approval}/approve`).set(auth(coordinator.token)).send({ note: 'Concurrent approval B' }),
    ]);

    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409], 'exactly one approval wins the row lock');

    const winner = first.status === 200 ? first : second;
    const applied = winner.body.data.applied;
    const bedsAfter = await prisma.bed.count({ where: { patientId: { not: null } } });
    assert.equal(bedsAfter, bedsBefore + applied.placements.length, 'the plan was applied exactly once');

    const confirmed = await prisma.allocation.count({ where: { approval: { reference: approval }, status: 'CONFIRMED' } });
    assert.equal(confirmed, applied.allocations, 'no duplicate allocation rows were confirmed');
  });

  test('a decision made against an outdated picture is refused and rolls back', async () => {
    /* Free a monitored escalation bay, plan against it, then let it be taken
       before the coordinator confirms. The stale selection must be refused. */
    const bay = await prisma.bed.findFirst({ where: { escalation: true, wardId: 'emergency' }, orderBy: { id: 'asc' } });
    if (bay.patientId) {
      await request().post(`/api/beds/${bay.id}/release`).set(auth(coordinator.token)).send({ reason: 'Clinical step-down confirmed for the test' });
      await request().patch(`/api/beds/${bay.id}/status`).set(auth(coordinator.token)).send({ status: 'Available' });
    }

    const optimization = await request()
      .post('/api/optimization')
      .set(auth(command.token))
      .send({ selections: { 'REC-ICU-01': 'icu-option-a' } });
    const approval = optimization.body.data.approval.id;
    const recommendation = optimization.body.data.recommendations.find((entry) => entry.id === 'REC-ICU-01');
    assert.ok(recommendation.options.some((option) => option.id === 'icu-option-a'), 'the escalation option is offered while the bay is free');

    /* The bay is committed to another case while the coordinator reviews. */
    const waiting = await prisma.patient.findFirst({ where: { queueEntry: { status: 'WAITING' }, requiredResource: 'Emergency Bed' } });
    if (waiting) {
      await request().post(`/api/beds/${bay.id}/assign`).set(auth(coordinator.token)).send({ patientId: waiting.patientNumber });
    } else {
      await prisma.bed.update({ where: { id: bay.id }, data: { status: 'RESERVED', heldFor: 'Committed elsewhere' } });
    }

    const bedsBefore = await prisma.bed.count({ where: { patientId: { not: null } } });
    const response = await request()
      .post(`/api/allocations/${approval}/approve`)
      .set(auth(coordinator.token))
      .send({ selections: { 'REC-ICU-01': 'icu-option-a' }, note: 'Confirm the plan from the review screen' });

    assert.equal(response.status, 409);
    assert.match(response.body.error.message, /no longer available|changed/i);

    const bedsAfter = await prisma.bed.count({ where: { patientId: { not: null } } });
    assert.equal(bedsAfter, bedsBefore, 'the refused confirmation changed nothing');
    const stored = await prisma.approval.findFirst({ where: { reference: approval } });
    assert.equal(stored.status, 'PENDING_REVIEW', 'the approval stays open for a corrected attempt');
  });

  test('the nursing workload constraint holds after an allocation', async () => {
    await request().post('/api/simulation').set(auth(command.token)).send({ patientCount: 16 });
    const optimization = await request().post('/api/optimization').set(auth(command.token)).send({});
    await request().post(`/api/allocations/${optimization.body.data.approval.id}/approve`).set(auth(coordinator.token)).send({ note: 'Workload constraint check' });

    const nurses = await prisma.nurse.findMany();
    assert.ok(nurses.every((nurse) => nurse.assignedPatients <= nurse.maxOperationalLoad), 'no nurse is pushed past the configured limit');
    const offDutyAssigned = nurses.filter((nurse) => nurse.dutyStatus !== 'ON_DUTY' && nurse.currentAssignment && /surge cover/i.test(nurse.currentAssignment));
    assert.equal(offDutyAssigned.length, 0, 'off-duty staff are never assigned');
  });

  test('simulated intake patients are marked so they can never be mistaken for live patients', async () => {
    const simulated = await prisma.patient.findMany({ where: { isSimulated: true } });
    assert.ok(simulated.length > 0, 'the surge intake is present');
    assert.ok(simulated.every((patient) => patient.simulationId), 'every simulated patient carries its simulation id');
    const live = await prisma.patient.findMany({ where: { patientNumber: { startsWith: 'IP-' } } });
    assert.ok(live.every((patient) => patient.isSimulated === false), 'live inpatients are untouched');
  });
});

describe('notifications', () => {
  test('notifications are persisted per user and scoped to that user', async () => {
    const coordinatorInbox = await request().get('/api/notifications').set(auth(coordinator.token));
    assert.equal(coordinatorInbox.status, 200);
    assert.ok(coordinatorInbox.body.notifications.length > 0, 'the coordinator has persisted notifications');
    assert.ok(coordinatorInbox.body.notifications.every((entry) => typeof entry.title === 'string'));

    const doctorInbox = await request().get('/api/notifications').set(auth(doctor.token));
    const leaked = doctorInbox.body.notifications.some((entry) => entry.title.includes('Approval request'));
    assert.equal(leaked, false, 'a doctor never receives coordinator-only notifications');
  });

  test('a notification can be marked as read without affecting other users', async () => {
    const inbox = await request().get('/api/notifications?unreadOnly=true').set(auth(coordinator.token));
    const first = inbox.body.notifications[0];
    assert.ok(first, 'an unread notification exists');

    const read = await request().post(`/api/notifications/${first.id}/read`).set(auth(coordinator.token)).send({});
    assert.equal(read.status, 200);
    assert.equal(read.body.data.read, true);

    const foreign = await request().post(`/api/notifications/${first.id}/read`).set(auth(doctor.token)).send({});
    assert.equal(foreign.status, 404, 'another user cannot read a notification that is not theirs');
  });
});

describe('alerts', () => {
  test('alerts carry the operational severity scale', async () => {
    const response = await request().get('/api/alerts').set(auth(command.token));
    assert.equal(response.status, 200);
    assert.ok(response.body.alerts.length > 0);
    assert.ok(response.body.alerts.every((alert) => ['CRITICAL', 'HIGH', 'OPERATIONAL', 'INFO'].includes(alert.severity)));
    assert.ok(response.body.alerts.every((alert) => ['Active', 'Acknowledged', 'Resolved'].includes(alert.status)));
  });

  test('alerts can be acknowledged and resolved', async () => {
    const list = await request().get('/api/alerts').set(auth(command.token));
    const target = list.body.alerts.find((alert) => alert.status === 'Active') || list.body.alerts[0];

    const acknowledged = await request().post(`/api/alerts/${target.dbId}/acknowledge`).set(auth(command.token)).send({});
    assert.equal(acknowledged.status, 200);
    const resolved = await request().post(`/api/alerts/${target.dbId}/resolve`).set(auth(command.token)).send({});
    assert.equal(resolved.body.data.status, 'Resolved');
  });
});
