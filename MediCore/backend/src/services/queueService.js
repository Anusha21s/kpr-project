/**
 * Queue service (§21, §33).
 *
 * The queue is the operational list of patients waiting for a resource. Order
 * is clinical priority first (recorded by triage), then longest wait — MediCore
 * never re-prioritises a patient on its own.
 */

const { prisma } = require('../config/database');
const { loadState } = require('../repositories/hospitalStateRepository');
const { rankQueue } = require('../optimization/scoringEngine');
const { calculateDemandProfile, calculateHospitalMetrics } = require('./metricsService');
const { ApiError } = require('../utils/ApiError');
const { emit, room, EVENTS } = require('../socket/bus');
const audit = require('./auditService');
const arrivalService = require('./arrivalService');

const QUEUE_ROOMS = [room.role('command_center'), room.role('resource_coordinator')];

async function list({ query = {}, scopeAuth = null } = {}) {
  const state = await loadState({ simulationId: 'auto' });

  let entries = state.queue;
  if (scopeAuth && ['doctor', 'nurse'].includes(scopeAuth.role)) {
    entries =
      scopeAuth.role === 'doctor'
        ? entries.filter((entry) => entry.assignedDoctorId === scopeAuth.staffRef)
        : entries.filter((entry) => entry.assignedNurseId === scopeAuth.staffRef);
  }

  if (query.priority) entries = entries.filter((entry) => entry.priority === query.priority);
  if (query.resource) entries = entries.filter((entry) => entry.requiredResource === query.resource);
  if (query.status) entries = entries.filter((entry) => entry.status === query.status);
  if (query.specialty) entries = entries.filter((entry) => entry.specialtyRequired === query.specialty);
  if (query.search) {
    const term = String(query.search).toLowerCase();
    entries = entries.filter((entry) =>
      [entry.id, entry.name, entry.department, entry.requiredResource].filter(Boolean).some((field) =>
        String(field).toLowerCase().includes(term),
      ),
    );
  }

  const ranked = rankQueue(entries).map((entry, index) => ({ ...entry, position: index + 1 }));
  return {
    queue: ranked,
    total: ranked.length,
    demand: calculateDemandProfile(ranked),
    pressure: calculateHospitalMetrics(state).pressure,
    generatedAt: new Date(),
  };
}

/** Adds a patient to the waiting list (registration / surge intake). */
async function add({ auth, payload }) {
  const created = await prisma.$transaction(async (tx) => {
    const patient = await tx.patient.create({
      data: {
        patientNumber: payload.patientNumber,
        name: payload.name || 'Unnamed patient',
        age: payload.age || null,
        sex: payload.sex || 'Unspecified',
        department: payload.department || 'Emergency',
        priority: payload.priority || 'Medium',
        triage: payload.triage || 'ESI 3',
        requiredResource: payload.requiredResource || null,
        secondaryResource: payload.secondaryResource || null,
        specialtyRequired: payload.specialtyRequired || null,
        requiresVentilator: Boolean(payload.requiresVentilator),
        needsOt: Boolean(payload.needsOt),
        clinicalRequirementBy: auth ? `${auth.name}${auth.staffRef ? ` · ${auth.staffRef}` : ''}` : null,
        requirementConfirmedAt: new Date(),
        notes: payload.notes || null,
        status: 'Waiting',
      },
    });

    const positions = await tx.patientQueue.count();
    const entry = await tx.patientQueue.create({
      data: {
        patientId: patient.id,
        priority: payload.priority || 'Medium',
        triage: payload.triage || 'ESI 3',
        requiredResource: payload.requiredResource || null,
        secondaryResource: payload.secondaryResource || null,
        waitingMinutes: payload.waitingMinutes || 0,
        position: positions + 1,
      },
    });

    /* Every registration is an arrival: the demand models read their flow from
       this log, so it is written in the same transaction as the patient row. */
    await arrivalService.record(
      {
        patientId: patient.id,
        patientNumber: patient.patientNumber,
        source: payload.source || 'AMBULANCE',
        priority: patient.priority,
        department: patient.department,
        triage: patient.triage,
        recordedById: auth ? auth.userId : null,
      },
      tx,
    );

    return { patient, entry };
  });

  audit.record({
    action: 'QUEUE_ENTRY_ADDED',
    auth,
    entity: 'Patient',
    entityId: created.patient.patientNumber,
    detail: { message: `${created.patient.patientNumber} added to the ${created.entry.priority} queue for ${created.entry.requiredResource || 'assessment'}`, tone: 'info' },
  });
  emit(EVENTS.QUEUE_UPDATED, { patientId: created.patient.patientNumber, status: 'Waiting' }, { rooms: QUEUE_ROOMS });

  return {
    id: created.patient.patientNumber,
    priority: created.entry.priority,
    requiredResource: created.entry.requiredResource,
    status: 'Waiting',
  };
}

/** Moves an entry out of the queue without a resource (escalation/transfer). */
async function escalate({ auth, id, reason }) {
  const patient = await prisma.patient.findFirst({
    where: { OR: [{ patientNumber: id }, { id }] },
    include: { queueEntry: true },
  });
  if (!patient) throw ApiError.notFound(`Queue entry ${id} was not found.`);
  if (!patient.queueEntry) throw ApiError.conflict(`${patient.patientNumber} is not in the queue.`);

  const [updated] = await prisma.$transaction([
    prisma.patientQueue.update({ where: { id: patient.queueEntry.id }, data: { escalated: true } }),
    prisma.patient.update({ where: { id: patient.id }, data: { notes: reason } }),
  ]);

  audit.record({
    action: 'QUEUE_ENTRY_ESCALATED',
    auth,
    entity: 'Patient',
    entityId: patient.patientNumber,
    detail: { message: `${patient.patientNumber} escalated for authorized review — ${reason}`, tone: 'alert' },
  });
  emit(EVENTS.QUEUE_UPDATED, { patientId: patient.patientNumber, status: 'Escalated' }, { rooms: QUEUE_ROOMS });

  return { id: patient.patientNumber, escalated: updated.escalated, reason };
}

module.exports = { list, add, escalate };
