/**
 * Theatre (OT) service (§25, §43).
 *
 * Theatre scheduling never cancels a planned procedure on its own. A theatre
 * can be *held* for an emergency case, which is a planning flag the theatre
 * coordinator reviews; the scheduled procedure keeps its slot until a person
 * decides otherwise.
 */

const { prisma } = require('../config/database');
const { loadState } = require('../repositories/hospitalStateRepository');
const { calculateOtAnalysis, calculateHospitalMetrics } = require('./metricsService');
const { ApiError } = require('../utils/ApiError');
const { emit, room, EVENTS } = require('../socket/bus');
const { minutesToLabel, nowMinutes } = require('../utils/time');
const audit = require('./auditService');

const OT_ROOMS = [room.role('command_center'), room.role('resource_coordinator'), room.department('OT Complex')];

async function list() {
  const state = await loadState({ simulationId: 'auto' });
  const analysis = calculateOtAnalysis(state.otRooms);
  const metrics = calculateHospitalMetrics(state);
  return {
    theatreRooms: state.otRooms,
    rooms: state.otRooms,
    backlog: state.otBacklog,
    summary: {
      total: analysis.total,
      active: analysis.active,
      ongoing: analysis.ongoing,
      scheduled: analysis.scheduled,
      available: analysis.available,
      held: analysis.held,
      maintenance: analysis.maintenance,
      conflicts: analysis.conflicts,
      requestsOutstanding: state.otBacklog.length,
      theatreUtilisation: analysis.total ? Math.round((analysis.active / analysis.total) * 1000) / 10 : 0,
    },
    demand: { surgicalRequests: state.otBacklog.length, needsOtInQueue: metrics.queue.otRequests },
    generatedAt: new Date(),
  };
}

/** Conflict view used by the OT scheduling screen. */
async function conflicts() {
  const state = await loadState({ simulationId: 'auto' });
  const roomConflicts = state.otRooms
    .filter((room) => room.conflict)
    .map((room) => ({
      id: `OTC-${room.id}`,
      theatreId: room.id,
      title: `${room.id} equipment conflict`,
      detail: room.conflictDetail,
      procedure: room.procedure,
      status: 'Open',
      actions: ['Verify equipment readiness with the theatre coordinator', 'Review the running list with authorized staff'],
    }));

  const equipmentConflicts = state.otRooms
    .filter((room) => room.scheduleId && Array.isArray(room.requiredEquipment) && room.requiredEquipment.length > 0)
    .map((room) => {
      const missing = room.requiredEquipment.filter((requirement) => {
        const category = state.equipment.find((entry) => entry.id === requirement.equipmentId || entry.name === requirement.name);
        return category ? category.total - category.inUse - (category.reserved || 0) <= 0 : false;
      });
      if (!missing.length) return null;
      return {
        id: `OTC-EQ-${room.id}`,
        theatreId: room.id,
        title: `${missing.map((entry) => entry.name || entry.equipmentId).join(', ')} unavailable for ${room.procedure}`,
        detail: 'Required equipment has no uncommitted unit for this slot. Equipment must be reviewed before the case proceeds.',
        procedure: room.procedure,
        status: 'Open',
        actions: ['Check equipment availability', 'Review with the theatre coordinator'],
      };
    })
    .filter(Boolean);

  return {
    conflicts: [...roomConflicts, ...equipmentConflicts],
    total: roomConflicts.length + equipmentConflicts.length,
    generatedAt: new Date(),
  };
}

/**
 * Holds a free theatre for an emergency case.
 * The hold is a planning flag: no scheduled procedure is cancelled, and the
 * theatre coordinator can release or confirm it.
 */
async function holdTheatre({ auth, theatreId, patientId = null, reason = 'Held for emergency surgical review', minutes = 120 }) {
  const theatre = await prisma.operatingTheatre.findUnique({ where: { id: theatreId } });
  if (!theatre) throw ApiError.notFound(`Theatre ${theatreId} does not exist.`);
  if (theatre.status === 'MAINTENANCE') throw ApiError.conflict(`${theatreId} is under maintenance and cannot be held.`);

  const patient = patientId
    ? await prisma.patient.findFirst({ where: { OR: [{ patientNumber: patientId }, { id: patientId }] } })
    : null;

  const startMinutes = nowMinutes();
  const endMinutes = startMinutes + minutes;

  const slot = await prisma.otSchedule.create({
    data: {
      theatreId,
      patientId: patient ? patient.id : null,
      patientLabel: patient ? patient.patientNumber : null,
      procedure: reason,
      priority: patient ? patient.priority : 'High',
      start: minutesToLabel(startMinutes),
      end: minutesToLabel(endMinutes),
      startMinutes,
      endMinutes,
      status: 'HELD',
      conflict: false,
    },
  });

  await prisma.operatingTheatre.update({ where: { id: theatreId }, data: { status: 'HELD' } });

  if (patient) {
    await prisma.patient.update({ where: { id: patient.id }, data: { assignedOtId: slot.id } });
    await prisma.patientQueue.updateMany({
      where: { patientId: patient.id },
      data: { status: 'ALLOCATION_PROPOSED' },
    });
  }

  audit.record({
    action: 'OT_HELD',
    auth,
    entity: 'OperatingTheatre',
    entityId: theatreId,
    detail: {
      message: `${theatreId} held${patient ? ` for ${patient.patientNumber}` : ''} — ${reason}. No scheduled procedure was cancelled.`,
      tone: 'info',
    },
  });
  emit(EVENTS.QUEUE_UPDATED, { theatreId, status: 'Held', patientId: patient ? patient.patientNumber : null }, { rooms: OT_ROOMS });

  return {
    theatreId,
    status: 'Held',
    scheduleId: slot.id,
    reference: slot.id,
    patientId: patient ? patient.patientNumber : null,
    from: minutesToLabel(startMinutes),
    to: minutesToLabel(endMinutes),
    note: 'Planned procedures keep their slots — the hold opens a review for the theatre coordinator.',
  };
}

async function releaseHold({ auth, theatreId, reason = 'Hold released by the theatre coordinator' }) {
  const theatre = await prisma.operatingTheatre.findUnique({ where: { id: theatreId } });
  if (!theatre) throw ApiError.notFound(`Theatre ${theatreId} does not exist.`);

  const held = await prisma.otSchedule.findFirst({ where: { theatreId, status: 'HELD' } });
  if (held) {
    await prisma.otSchedule.update({
      where: { id: held.id },
      data: { status: 'CANCELLED', conflictDetail: reason },
    });
    if (held.patientId) {
      await prisma.patient.update({ where: { id: held.patientId }, data: { assignedOtId: null } });
    }
  }

  await prisma.operatingTheatre.update({ where: { id: theatreId }, data: { status: 'AVAILABLE' } });

  audit.record({
    action: 'OT_HOLD_RELEASED',
    auth,
    entity: 'OperatingTheatre',
    entityId: theatreId,
    detail: { message: `${theatreId} hold released — ${reason}`, tone: 'info' },
  });
  emit(EVENTS.QUEUE_UPDATED, { theatreId, status: 'Available' }, { rooms: OT_ROOMS });

  return { theatreId, status: 'Available', released: Boolean(held) };
}

module.exports = { list, conflicts, holdTheatre, releaseHold };
