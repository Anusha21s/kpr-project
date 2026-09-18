/**
 * Bed service (§39, §48).
 *
 * Bed occupancy is owned by the bed row. Assigning or releasing a bed happens
 * inside a transaction with a row lock, so two coordinators acting on the same
 * bed (rare but real — e.g. ICU-05) can never both succeed.
 */

const { prisma } = require('../config/database');
const { loadState } = require('../repositories/hospitalStateRepository');
const { calculateWardStats, calculateCapacity } = require('./metricsService');
const { ApiError } = require('../utils/ApiError');
const { emit, room, EVENTS } = require('../socket/bus');
const audit = require('./auditService');

const BED_ROOMS = [room.role('command_center'), room.role('resource_coordinator')];

const UI_TO_CODE = {
  Available: 'AVAILABLE',
  Occupied: 'OCCUPIED',
  Reserved: 'RESERVED',
  Cleaning: 'CLEANING',
  Maintenance: 'MAINTENANCE',
};

async function list({ wardId = null } = {}) {
  const state = await loadState({ simulationId: 'auto' });
  const units = wardId ? state.bedUnits.filter((unit) => unit.wardId === wardId) : state.bedUnits;
  return {
    beds: units,
    wards: calculateWardStats(state.bedUnits),
    summary: calculateCapacity(state.bedUnits),
    total: units.length,
  };
}

/**
 * Assigns a patient to a bed.
 * Locks the bed row, verifies the bed is still free, then writes the occupancy
 * on the bed, the mirror on the patient and any queue resolution — all in one
 * transaction. A failure leaves the database untouched.
 */
async function assign({ auth, bedId, patientId, note = null }) {
  const result = await prisma.$transaction(async (tx) => {
    /* Row lock: a second coordinator acting on the same bed waits here, then
       sees the committed occupancy and is rejected instead of double-booking. */
    const locked = await tx.$queryRaw`
      SELECT id, "wardId", status, "patientId" FROM "Bed" WHERE id = ${bedId} FOR UPDATE
    `;
    const bedRow = Array.isArray(locked) ? locked[0] : null;
    if (!bedRow) throw ApiError.notFound(`Bed ${bedId} does not exist.`);
    if (bedRow.patientId) {
      throw ApiError.conflict(`Bed ${bedId} is already occupied — concurrency check prevented a double allocation.`);
    }
    if (!['AVAILABLE', 'CLEANING'].includes(bedRow.status)) {
      throw ApiError.conflict(`Bed ${bedId} is ${String(bedRow.status).toLowerCase()} and cannot be allocated.`);
    }

    const patient = await tx.patient.findFirst({
      where: { OR: [{ patientNumber: patientId }, { id: patientId }] },
      include: { queueEntry: true },
    });
    if (!patient) throw ApiError.notFound(`Patient ${patientId} was not found.`);
    if (patient.occupiedBed) {
      throw ApiError.conflict(`Patient ${patient.patientNumber} already holds ${patient.assignedBedId}.`);
    }

    const ward = await tx.bed.findUnique({ where: { id: bedId }, select: { wardId: true, ward: true } });

    const updatedBed = await tx.bed.update({
      where: { id: bedId },
      data: {
        status: 'OCCUPIED',
        patientId: patient.id,
        patientRef: patient.patientNumber,
        heldFor: null,
        availableFrom: null,
      },
    });

    const updatedPatient = await tx.patient.update({
      where: { id: patient.id },
      data: {
        assignedBedId: bedId,
        department: ward.ward,
        status: patient.status === 'Waiting' ? 'Admitted' : patient.status,
      },
    });

    if (patient.queueEntry) {
      await tx.patientQueue.update({
        where: { id: patient.queueEntry.id },
        data: { status: 'ALLOCATED', resolvedAt: new Date() },
      });
    }

    return { bed: updatedBed, patient: updatedPatient, ward };
  }, { timeout: 15000 });

  audit.record({
    action: 'BED_ASSIGNED',
    auth,
    entity: 'Bed',
    entityId: bedId,
    detail: { message: `${result.patient.patientNumber} placed in ${bedId}${note ? ` — ${note}` : ''}`, tone: 'success' },
  });

  emit(EVENTS.BED_UPDATED, { bedId, status: 'Occupied', patientId: result.patient.patientNumber }, {
    rooms: [...BED_ROOMS, room.department(result.ward.ward)],
  });
  emit(EVENTS.QUEUE_UPDATED, { patientId: result.patient.patientNumber, status: 'Placed' }, { rooms: BED_ROOMS });

  return {
    bed: { id: result.bed.id, status: 'Occupied', ward: result.bed.ward, patientId: result.patient.patientNumber },
    patient: { id: result.patient.patientNumber, bed: bedId, status: result.patient.status },
  };
}

/** Removes a patient from a bed (discharge or transfer). Never automatic. */
async function release({ auth, bedId, reason = 'Discharge confirmed by clinical staff' }) {
  const result = await prisma.$transaction(async (tx) => {
    const bed = await tx.bed.findUnique({ where: { id: bedId } });
    if (!bed) throw ApiError.notFound(`Bed ${bedId} does not exist.`);

    const patient = bed.patientId ? await tx.patient.findUnique({ where: { id: bed.patientId } }) : null;

    if (patient) {
      await tx.patient.update({ where: { id: patient.id }, data: { assignedBedId: null, status: 'Discharged' } });
    }

    await tx.bed.update({
      where: { id: bedId },
      data: { status: 'CLEANING', patientId: null, patientRef: null, availableFrom: new Date(Date.now() + 45 * 60 * 1000), notes: reason },
    });

    return { bed, patient };
  });

  audit.record({
    action: 'BED_RELEASED',
    auth,
    entity: 'Bed',
    entityId: bedId,
    detail: { message: `${bedId} released for cleaning${result.patient ? ` after ${result.patient.patientNumber}` : ''} — ${reason}`, tone: 'info' },
  });
  emit(EVENTS.BED_UPDATED, { bedId, status: 'Cleaning' }, {
    rooms: [...BED_ROOMS, room.department(result.bed.ward)],
  });

  return { bedId, status: 'Cleaning', availableFrom: undefined };
}

/** Hold or free a bed without touching occupancy (planning only). */
async function setStatus({ auth, bedId, status, heldFor = null }) {
  const code = UI_TO_CODE[status] || String(status).toUpperCase();
  if (!Object.values(UI_TO_CODE).includes(code)) throw ApiError.validation(`Unsupported bed status "${status}".`);

  const bed = await prisma.bed.findUnique({ where: { id: bedId } });
  if (!bed) throw ApiError.notFound(`Bed ${bedId} does not exist.`);
  if (bed.patientId && ['AVAILABLE', 'MAINTENANCE'].includes(code)) {
    throw ApiError.conflict(`Bed ${bedId} still holds a patient — occupancy must be changed through a discharge or transfer confirmation.`);
  }

  const updated = await prisma.bed.update({
    where: { id: bedId },
    data: {
      status: code,
      heldFor: code === 'RESERVED' ? heldFor || 'Held for an incoming case' : null,
      availableFrom: code === 'AVAILABLE' ? null : bed.availableFrom,
    },
  });

  audit.record({
    action: 'BED_STATUS_CHANGED',
    auth,
    entity: 'Bed',
    entityId: bedId,
    detail: { message: `${bedId} set to ${status}${heldFor ? ` — ${heldFor}` : ''}`, tone: 'info' },
  });
  emit(EVENTS.BED_UPDATED, { bedId, status: updated.status }, { rooms: [...BED_ROOMS, room.department(bed.ward)] });

  return { id: updated.id, status: updated.status, heldFor: updated.heldFor };
}

async function wardStats() {
  const state = await loadState({ simulationId: 'auto' });
  const wards = calculateWardStats(state.bedUnits);
  return { wards, summary: calculateCapacity(state.bedUnits) };
}

module.exports = { list, assign, release, setStatus, wardStats };
