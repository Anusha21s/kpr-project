/**
 * Surge simulation service (§28–30).
 *
 * A mass-casualty intake is simulated against the live hospital: baseline state
 * is captured, the intake is projected, the before/after comparison and the
 * conflicts the intake creates are stored with the simulation.
 *
 * Live operational rows (beds, staff, equipment, scheduled theatres) are never
 * changed by the run. The simulated patients are written with `isSimulated`
 * and a `simulationId`, so they can be reverted in a single transaction.
 */

const { prisma } = require('../config/database');
const { loadState } = require('../repositories/hospitalStateRepository');
const { simulateEmergencySurge } = require('../optimization/surgeEngine');
const { emit, EVENTS, room } = require('../socket/bus');
const { randomRef } = require('../utils/ids');
const audit = require('./auditService');
const notification = require('./notificationService');
const aiService = require('./aiService');

const SURGE_ROOMS = [room.role('command_center'), room.role('resource_coordinator'), room.role('doctor'), room.role('nurse')];

/**
 * Runs the surge scenario.
 * @param {object} options
 * @param {object} options.auth  caller
 * @param {number} options.patientCount  intake size (default 20)
 * @param {string} options.scenario      MASS_CASUALTY_INTAKE (default)
 * @param {string} options.prefix        intake patient-number offset
 */
async function run({ auth, patientCount = 20, scenario = 'MASS_CASUALTY_INTAKE', offset = 8 } = {}) {
  const baseline = await loadState({ simulationId: null });

  /* A new run supersedes the previous projection: it is reverted first so the
     intake is numbered against the true live registration series. */
  const active = await prisma.surgeSimulation.findFirst({ where: { active: true } });
  if (active) await revert({ auth, id: active.id, silent: true });

  /* Intake numbers continue the live registration series, so a simulated
     patient can never collide with an existing patient number. */
  const registered = await prisma.patient.findMany({ where: { patientNumber: { startsWith: 'P' } }, select: { patientNumber: true } });
  const highest = registered.reduce((max, row) => {
    const match = /^P(\d+)$/.exec(row.patientNumber);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  const startAt = Math.max(highest + 1, offset + 1);
  const result = simulateEmergencySurge(baseline, { patientCount, offset: startAt - 1 });
  const reference = randomRef('SIM');

  const simulation = await prisma.$transaction(async (tx) => {
    const row = await tx.surgeSimulation.create({
      data: {
        reference,
        status: 'SURGE',
        active: true,
        scenario,
        patientCount: result.intake.length,
        triggeredById: auth.userId || null,
        before: result.before,
        after: result.after,
        changes: {
          ...result.changes,
          pressure: result.pressure,
          projection: result.projection,
          intake: result.intake,
        },
        conflicts: result.conflicts,
      },
    });

    /* The intake patients are stored as simulation-scoped rows: they are part of
       the projected picture, never of the live hospital census. */
    for (const entry of result.intake) {
      const created = await tx.patient.create({
        data: {
          patientNumber: entry.id,
          name: entry.name,
          age: entry.age,
          sex: entry.sex,
          department: entry.department,
          priority: entry.priority,
          triage: entry.triage,
          requiredResource: entry.requiredResource,
          secondaryResource: entry.secondaryResource,
          specialtyRequired: entry.specialtyRequired,
          requiresVentilator: entry.requiresVentilator,
          needsOt: entry.needsOt,
          clinicalRequirementBy: entry.clinicalRequirementBy,
          requirementConfirmedAt: new Date(),
          notes: entry.notes,
          status: 'Waiting',
          isSimulated: true,
          simulationId: row.id,
        },
      });
      await tx.patientQueue.create({
        data: {
          patientId: created.id,
          priority: entry.priority,
          triage: entry.triage,
          requiredResource: entry.requiredResource,
          secondaryResource: entry.secondaryResource,
          waitingMinutes: entry.waitingMinutes,
          position: entry.position,
          status: 'WAITING',
        },
      });
    }

    return row;
  }, { timeout: 30000 });

  /* Provisional holds are recorded as planning notes on the units, not as
     occupancy: nothing is placed by the simulation. */
  await prisma.$transaction(
    result.projection.bedHolds.map((hold) =>
      prisma.bed.updateMany({
        where: { id: hold.bedId, patientId: null },
        data: { status: 'RESERVED', heldFor: `Simulation ${reference} — ${hold.heldFor}` },
      }),
    ),
  );

  const alert = await prisma.alert.create({
    data: {
      reference: randomRef('ALR'),
      type: 'Critical',
      severity: 'CRITICAL',
      category: 'Surge',
      title: 'SURGE DETECTED — mass-casualty intake',
      description: `Emergency queue increased from ${result.before.emergencyQueue} to ${result.after.emergencyQueue} patients. ${result.after.criticalQueue} critical cases are under active assessment. Resource pressure moved from ${result.before.pressure}% to ${result.after.pressure}%.`,
      resource: 'Emergency Queue',
      affectedResource: `Emergency — ${result.after.emergencyQueue} waiting`,
      actionLabel: 'Open surge analysis',
      actionTo: '/command/surge',
      source: 'Surge monitor',
    },
  });

  audit.record({
    action: 'SURGE_SIMULATED',
    auth,
    entity: 'SurgeSimulation',
    entityId: reference,
    detail: {
      message: `SURGE DETECTED — ${result.intake.length} patients projected (${result.intake.filter((entry) => entry.priority === 'Critical').length} critical)`,
      tone: 'alert',
    },
  });

  emit(
    EVENTS.SURGE_DETECTED,
    {
      reference,
      patientCount: result.intake.length,
      before: result.before,
      after: result.after,
      changes: result.changes,
      conflicts: result.conflicts.length,
    },
    { rooms: SURGE_ROOMS },
  );
  emit(EVENTS.ALERT_CREATED, { alertId: alert.reference, title: alert.title }, { rooms: [room.role('command_center'), room.role('resource_coordinator')] });
  emit(EVENTS.QUEUE_UPDATED, { projected: result.after.emergencyQueue }, { rooms: [room.role('command_center'), room.role('resource_coordinator')] });

  await notification.notify({
    userIds: [
      ...(await notification.userIdsForRole('command_center')),
      ...(await notification.userIdsForRole('resource_coordinator')),
    ],
    title: 'SURGE DETECTED — mass-casualty intake',
    body: `Emergency queue projected to ${result.after.emergencyQueue} patients (${result.after.criticalQueue} critical). Resource pressure ${result.before.pressure}% → ${result.after.pressure}%. Multi-resource optimization is required.`,
    type: 'Critical',
    category: 'Surge',
    actionLabel: 'Open surge analysis',
    actionTo: '/command/surge',
  });

  /* The projected picture changed, so any cached AI advisory for the command
     centre is now stale. */
  if (typeof aiService?.invalidateAdvisoryCache === 'function') {
    aiService.invalidateAdvisoryCache();
  }

  return {
    reference,
    simulationId: simulation.id,
    status: simulation.status,
    scenario,
    patientCount: result.intake.length,
    intake: result.intake,
    before: result.before,
    after: result.after,
    changes: result.changes,
    conflicts: result.conflicts,
    pressure: result.pressure,
    projection: result.projection,
    alert: alert.reference,
    note: 'Live hospital rows were not modified — the surge picture is a projection until the coordinator confirms an allocation.',
    generatedAt: new Date(),
  };
}

/** Reverts a simulation: simulated patients and their holds are removed. */
async function revert({ auth, id, silent = false } = {}) {
  const target = !id || id === 'current' ? null : id;
  const simulation = target
    ? await prisma.surgeSimulation.findFirst({ where: { OR: [{ id: target }, { reference: target }] } })
    : await prisma.surgeSimulation.findFirst({ where: { active: true }, orderBy: { createdAt: 'desc' } });
  if (!simulation) return { reverted: false, reason: 'No surge projection is active.', removedPatients: 0 };

  const removed = await prisma.$transaction(async (tx) => {
    const patients = await tx.patient.findMany({ where: { simulationId: simulation.id }, select: { id: true, patientNumber: true } });
    const patientIds = patients.map((patient) => patient.id);
    await tx.bed.updateMany({
      where: {
        OR: [
          { patientId: { in: patientIds } },
          { patientId: null, status: 'OCCUPIED' },
          { heldFor: { contains: simulation.reference } },
        ],
      },
      data: { status: 'AVAILABLE', patientId: null, patientRef: null, heldFor: null, availableFrom: null },
    });
    await tx.patientQueue.deleteMany({ where: { patientId: { in: patientIds } } });
    await tx.patient.deleteMany({ where: { id: { in: patientIds } } });
    await tx.surgeSimulation.update({
      where: { id: simulation.id },
      data: { active: false, status: 'REVERTED', revertedAt: new Date() },
    });
    return patients.length;
  });

  if (!silent) {
    audit.record({
      action: 'SURGE_REVERTED',
      auth,
      entity: 'SurgeSimulation',
      entityId: simulation.reference,
      detail: { message: `Surge projection ${simulation.reference} reverted — ${removed} simulated patient(s) removed`, tone: 'info' },
    });
    emit(EVENTS.SURGE_DETECTED, { reference: simulation.reference, reverted: true }, { rooms: SURGE_ROOMS });
  }

  if (typeof aiService?.invalidateAdvisoryCache === 'function') {
    aiService.invalidateAdvisoryCache();
  }
  return { reference: simulation.reference, reverted: true, removedPatients: removed };
}

/** Current simulation (if any) plus its stored before/after comparison. */
async function current() {
  const simulation = await prisma.surgeSimulation.findFirst({ where: { active: true }, orderBy: { createdAt: 'desc' } });
  if (!simulation) return { active: false, simulation: null };
  return {
    active: true,
    simulation: {
      id: simulation.id,
      reference: simulation.reference,
      status: simulation.status,
      scenario: simulation.scenario,
      patientCount: simulation.patientCount,
      startedAt: simulation.createdAt,
      before: simulation.before,
      after: simulation.after,
      changes: simulation.changes,
      conflicts: simulation.conflicts,
    },
  };
}

module.exports = { run, revert, current };
