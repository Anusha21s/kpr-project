/**
 * Patient service (§20, §47).
 *
 * Reads are role-scoped: command centre and the resource coordinator see the
 * whole hospital, a doctor sees only patients assigned to them, a nurse only
 * patients assigned to them. The scope is applied server-side — the client
 * cannot widen it with a query parameter.
 */

const { prisma } = require('../config/database');
const { loadState } = require('../repositories/hospitalStateRepository');
const { toClinicalPatient } = require('./dashboardService');
const { ApiError } = require('../utils/ApiError');

const isClinical = (role) => role === 'doctor' || role === 'nurse';

/** Maps loaded state → clinical record rows, with the caller's tasks attached. */
function toRows(state) {
  const tasks = Object.values(state.clinicalTasks);
  return state.patients.map((patient) => toClinicalPatient(patient, tasks));
}

/**
 * @param {object} options
 * @param {object} options.auth    authenticated caller
 * @param {object} options.query   { ward, priority, status, search, assignedDoctor, mine }
 */
async function list({ auth, query = {}, simulationId = 'auto' } = {}) {
  const state = await loadState({ simulationId });
  let rows = toRows(state);

  if (isClinical(auth.role)) {
    rows =
      auth.role === 'doctor'
        ? rows.filter((patient) => patient.assignedDoctors.includes(auth.staffRef))
        : rows.filter((patient) => patient.assignedNurses.includes(auth.staffRef));
  }

  const wantsMine =
    query.mine === true ||
    query.mine === 'true' ||
    query.assignedDoctor === 'me' ||
    query.assignedNurse === 'me';

  if (wantsMine && !isClinical(auth.role)) {
    /* The command centre can ask for "mine" too — it has none, but the request
       must not fail, it simply answers with an empty list. */
    rows = [];
  }

  if (query.ward) rows = rows.filter((patient) => String(patient.ward).toLowerCase().includes(String(query.ward).toLowerCase()));
  if (query.priority) rows = rows.filter((patient) => patient.priority === query.priority);
  if (query.status) rows = rows.filter((patient) => patient.status === query.status);
  if (query.assignedDoctor && query.assignedDoctor !== 'me') {
    rows = rows.filter((patient) => patient.assignedDoctors.includes(query.assignedDoctor));
  }
  if (query.specialty) rows = rows.filter((patient) => patient.specialtyRequired === query.specialty);
  if (query.search) {
    const term = String(query.search).toLowerCase();
    rows = rows.filter((patient) =>
      [patient.id, patient.name, patient.diagnosis, patient.bed, patient.ward]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(term)),
    );
  }
  if (query.inQueue === true || query.inQueue === 'true') rows = rows.filter((patient) => Boolean(patient.queueStatus));

  return {
    patients: rows,
    total: rows.length,
    scope: isClinical(auth.role) ? 'own-assignments' : 'hospital',
    generatedAt: new Date(),
  };
}

/** `GET /api/patients/my` — the caller's own assignments, always scoped. */
async function mine({ auth, query = {} } = {}) {
  if (!isClinical(auth.role)) {
    return {
      patients: [],
      total: 0,
      scope: 'own-assignments',
      note: 'This account is not a clinical assignment holder — operational lists are available under /api/patients.',
      generatedAt: new Date(),
    };
  }
  return list({ auth, query: { ...query, mine: true } });
}

async function getById({ auth, id }) {
  const state = await loadState({ simulationId: 'auto' });
  const rows = toRows(state);
  const row = rows.find((patient) => patient.id === id || patient.dbId === id);
  if (!row) throw ApiError.notFound(`Patient ${id} was not found.`);

  if (isClinical(auth.role)) {
    const owns =
      auth.role === 'doctor' ? row.assignedDoctors.includes(auth.staffRef) : row.assignedNurses.includes(auth.staffRef);
    if (!owns) throw ApiError.forbidden('This patient is not assigned to your account.');
  }

  const detail = state.patients.find((patient) => patient.id === row.dbId);
  const tasks = Object.values(state.clinicalTasks).filter((task) => task.patientNumber === row.id);
  const allocations = state.allocations.filter((allocation) => allocation.patientId === row.id);
  const alerts = state.alerts.filter((alert) => alert.patientNumber === row.id);
  const otSlots = state.otBacklog.filter((slot) => slot.patientNumber === row.id);

  return { ...row, detail, tasks, allocations, alerts, otSlots };
}

const audit = require('./auditService');
const { emit, room, EVENTS } = require('../socket/bus');

const QUEUE_ROOMS = [
  room.role('command_center'),
  room.role('resource_coordinator'),
  room.role('doctor'),
  room.role('nurse'),
];

/**
 * Creates a new patient record manually (§6 Manual Patient Management).
 */
async function create({ auth, payload }) {
  const result = await prisma.$transaction(async (tx) => {
    // Generate sequential patientNumber if not supplied
    let patientNumber = payload.patientNumber;
    if (!patientNumber) {
      const existing = await tx.patient.findMany({
        where: { patientNumber: { startsWith: 'P' } },
        select: { patientNumber: true },
      });
      const highest = existing.reduce((max, row) => {
        const match = /^P(\d+)$/.exec(row.patientNumber);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 25);
      patientNumber = `P${String(highest + 1).padStart(3, '0')}`;
    } else {
      const duplicate = await tx.patient.findUnique({ where: { patientNumber } });
      if (duplicate) throw ApiError.conflict(`Patient with ID ${patientNumber} already exists.`);
    }

    // Validate bed assignment if requested
    let assignedBedId = payload.assignedBedId || null;
    if (assignedBedId) {
      const bed = await tx.bed.findUnique({ where: { id: assignedBedId } });
      if (!bed) throw ApiError.notFound(`Bed ${assignedBedId} does not exist.`);
      if (bed.patientId || !['AVAILABLE', 'CLEANING'].includes(bed.status)) {
        throw ApiError.conflict(`Bed ${assignedBedId} is already occupied or unavailable.`);
      }
    }

    // Validate doctor assignment if requested
    let assignedDoctorId = payload.assignedDoctorId || null;
    if (assignedDoctorId) {
      const doctor = await tx.doctor.findUnique({ where: { id: assignedDoctorId } });
      if (!doctor) throw ApiError.notFound(`Doctor ${assignedDoctorId} does not exist.`);
      if (doctor.dutyStatus !== 'ON_DUTY' || doctor.availability === 'Unavailable') {
        throw ApiError.conflict(`Doctor ${doctor.name} (${assignedDoctorId}) is currently ${doctor.availability || doctor.dutyStatus}.`);
      }
      await tx.doctor.update({
        where: { id: assignedDoctorId },
        data: {
          patients: doctor.patients + 1,
          availability: doctor.patients + 1 >= doctor.maxOperationalLoad ? 'Assigned' : doctor.availability,
        },
      });
    }

    // Validate nurse assignment if requested
    let assignedNurseId = payload.assignedNurseId || null;
    if (assignedNurseId) {
      const nurse = await tx.nurse.findUnique({ where: { id: assignedNurseId } });
      if (!nurse) throw ApiError.notFound(`Nurse ${assignedNurseId} does not exist.`);
      if (nurse.dutyStatus !== 'ON_DUTY') {
        throw ApiError.conflict(`Nurse ${nurse.name} (${assignedNurseId}) is off-duty.`);
      }
      if (nurse.assignedPatients >= nurse.maxOperationalLoad) {
        throw ApiError.conflict(`Nurse ${nurse.name} (${assignedNurseId}) has reached workload limit (${nurse.maxOperationalLoad} patients).`);
      }
      await tx.nurse.update({
        where: { id: assignedNurseId },
        data: {
          assignedPatients: nurse.assignedPatients + 1,
          workload: nurse.assignedPatients + 1 >= nurse.maxOperationalLoad ? 'High' : nurse.workload,
        },
      });
    }

    const patient = await tx.patient.create({
      data: {
        patientNumber,
        name: payload.name,
        age: payload.age || null,
        sex: payload.sex || null,
        department: payload.department || 'Emergency',
        priority: payload.priority || 'Medium',
        triage: payload.triage || 'ESI 3',
        requiredResource: payload.requiredResource || null,
        secondaryResource: payload.secondaryResource || null,
        specialtyRequired: payload.specialtyRequired || null,
        requiresVentilator: Boolean(payload.requiresVentilator),
        needsOt: Boolean(payload.needsOt),
        clinicalRequirementBy: payload.clinicalRequirementBy || (auth.staffRef ? `${auth.name} · ${auth.staffRef}` : auth.name),
        requirementConfirmedAt: new Date(),
        notes: payload.notes || null,
        diagnosis: payload.diagnosis || null,
        status: assignedBedId ? 'Admitted' : payload.status || 'Waiting',
        assignedBedId,
        assignedDoctorId,
        assignedNurseId,
      },
    });

    if (assignedBedId) {
      await tx.bed.update({
        where: { id: assignedBedId },
        data: {
          status: 'OCCUPIED',
          patientId: patient.id,
          patientRef: patient.patientNumber,
          heldFor: null,
          availableFrom: null,
        },
      });
    }

    // If waiting in emergency, register queue row
    if (!assignedBedId || payload.status === 'Waiting') {
      await tx.patientQueue.create({
        data: {
          patientId: patient.id,
          priority: patient.priority,
          triage: patient.triage,
          requiredResource: patient.requiredResource,
          secondaryResource: patient.secondaryResource,
          status: assignedBedId ? 'ALLOCATED' : 'WAITING',
          waitingMinutes: 0,
        },
      });
    }

    // Log arrival
    await tx.arrivalLog.create({
      data: {
        patientId: patient.id,
        patientNumber: patient.patientNumber,
        source: payload.triage?.includes('1') ? 'AMBULANCE' : 'WALK_IN',
        priority: patient.priority,
        department: patient.department,
        triage: patient.triage,
        arrivedAt: new Date(),
        recordedById: auth.userId || null,
      },
    });

    return patient;
  });

  audit.record({
    action: 'PATIENT_CREATED',
    auth,
    entity: 'Patient',
    entityId: result.patientNumber,
    detail: { message: `Patient ${result.patientNumber} (${result.name}) created in ${result.department}`, tone: 'success' },
  });

  emit(EVENTS.QUEUE_UPDATED, { patientId: result.patientNumber, action: 'CREATED' }, { rooms: QUEUE_ROOMS });
  if (result.assignedBedId) {
    emit(EVENTS.BED_UPDATED, { bedId: result.assignedBedId, status: 'Occupied', patientId: result.patientNumber }, { rooms: QUEUE_ROOMS });
  }

  return result;
}

/**
 * Updates patient operational details (§7 Edit Patient).
 */
async function update({ auth, id, payload }) {
  const result = await prisma.$transaction(async (tx) => {
    const patient = await tx.patient.findFirst({
      where: { OR: [{ patientNumber: id }, { id }] },
      include: { queueEntry: true },
    });
    if (!patient) throw ApiError.notFound(`Patient ${id} was not found.`);

    // Handle bed change if specified
    let nextBedId = patient.assignedBedId;
    if ('assignedBedId' in payload) {
      if (payload.assignedBedId !== patient.assignedBedId) {
        // Release old bed if held
        if (patient.assignedBedId) {
          await tx.bed.update({
            where: { id: patient.assignedBedId },
            data: { status: 'AVAILABLE', patientId: null, patientRef: null, heldFor: null },
          });
        }
        // Occupy new bed if provided
        if (payload.assignedBedId) {
          const newBed = await tx.bed.findUnique({ where: { id: payload.assignedBedId } });
          if (!newBed) throw ApiError.notFound(`Bed ${payload.assignedBedId} does not exist.`);
          if (newBed.patientId && newBed.patientId !== patient.id) {
            throw ApiError.conflict(`Bed ${payload.assignedBedId} is already occupied.`);
          }
          await tx.bed.update({
            where: { id: payload.assignedBedId },
            data: { status: 'OCCUPIED', patientId: patient.id, patientRef: patient.patientNumber },
          });
        }
        nextBedId = payload.assignedBedId || null;
      }
    }

    // Handle doctor change
    let nextDoctorId = patient.assignedDoctorId;
    if ('assignedDoctorId' in payload && payload.assignedDoctorId !== patient.assignedDoctorId) {
      if (patient.assignedDoctorId) {
        const oldDoc = await tx.doctor.findUnique({ where: { id: patient.assignedDoctorId } });
        if (oldDoc) {
          await tx.doctor.update({
            where: { id: oldDoc.id },
            data: {
              patients: Math.max(0, oldDoc.patients - 1),
              availability: oldDoc.patients - 1 < oldDoc.maxOperationalLoad ? 'Available' : oldDoc.availability,
            },
          });
        }
      }
      if (payload.assignedDoctorId) {
        const newDoc = await tx.doctor.findUnique({ where: { id: payload.assignedDoctorId } });
        if (!newDoc) throw ApiError.notFound(`Doctor ${payload.assignedDoctorId} does not exist.`);
        if (newDoc.dutyStatus !== 'ON_DUTY' || newDoc.availability === 'Unavailable') {
          throw ApiError.conflict(`Doctor ${newDoc.name} is currently unavailable.`);
        }
        await tx.doctor.update({
          where: { id: newDoc.id },
          data: {
            patients: newDoc.patients + 1,
            availability: newDoc.patients + 1 >= newDoc.maxOperationalLoad ? 'Assigned' : newDoc.availability,
          },
        });
      }
      nextDoctorId = payload.assignedDoctorId || null;
    }

    // Handle nurse change
    let nextNurseId = patient.assignedNurseId;
    if ('assignedNurseId' in payload && payload.assignedNurseId !== patient.assignedNurseId) {
      if (patient.assignedNurseId) {
        const oldNurse = await tx.nurse.findUnique({ where: { id: patient.assignedNurseId } });
        if (oldNurse) {
          await tx.nurse.update({
            where: { id: oldNurse.id },
            data: {
              assignedPatients: Math.max(0, oldNurse.assignedPatients - 1),
              workload: oldNurse.assignedPatients - 1 >= oldNurse.maxOperationalLoad ? 'High' : 'Moderate',
            },
          });
        }
      }
      if (payload.assignedNurseId) {
        const newNurse = await tx.nurse.findUnique({ where: { id: payload.assignedNurseId } });
        if (!newNurse) throw ApiError.notFound(`Nurse ${payload.assignedNurseId} does not exist.`);
        if (newNurse.dutyStatus !== 'ON_DUTY') {
          throw ApiError.conflict(`Nurse ${newNurse.name} is off-duty.`);
        }
        if (newNurse.assignedPatients >= newNurse.maxOperationalLoad) {
          throw ApiError.conflict(`Nurse ${newNurse.name} is at workload limit (${newNurse.maxOperationalLoad}).`);
        }
        await tx.nurse.update({
          where: { id: newNurse.id },
          data: {
            assignedPatients: newNurse.assignedPatients + 1,
            workload: newNurse.assignedPatients + 1 >= newNurse.maxOperationalLoad ? 'High' : newNurse.workload,
          },
        });
      }
      nextNurseId = payload.assignedNurseId || null;
    }

    const updated = await tx.patient.update({
      where: { id: patient.id },
      data: {
        name: payload.name !== undefined ? payload.name : patient.name,
        age: payload.age !== undefined ? payload.age : patient.age,
        sex: payload.sex !== undefined ? payload.sex : patient.sex,
        department: payload.department !== undefined ? payload.department : patient.department,
        priority: payload.priority !== undefined ? payload.priority : patient.priority,
        triage: payload.triage !== undefined ? payload.triage : patient.triage,
        status: payload.status !== undefined ? payload.status : patient.status,
        requiredResource: payload.requiredResource !== undefined ? payload.requiredResource : patient.requiredResource,
        secondaryResource: payload.secondaryResource !== undefined ? payload.secondaryResource : patient.secondaryResource,
        specialtyRequired: payload.specialtyRequired !== undefined ? payload.specialtyRequired : patient.specialtyRequired,
        requiresVentilator: payload.requiresVentilator !== undefined ? payload.requiresVentilator : patient.requiresVentilator,
        needsOt: payload.needsOt !== undefined ? payload.needsOt : patient.needsOt,
        notes: payload.notes !== undefined ? payload.notes : patient.notes,
        diagnosis: payload.diagnosis !== undefined ? payload.diagnosis : patient.diagnosis,
        assignedBedId: nextBedId,
        assignedDoctorId: nextDoctorId,
        assignedNurseId: nextNurseId,
      },
    });

    if (patient.queueEntry) {
      await tx.patientQueue.update({
        where: { id: patient.queueEntry.id },
        data: {
          priority: updated.priority,
          triage: updated.triage,
          requiredResource: updated.requiredResource,
          status: updated.status === 'Discharged' ? 'CLOSED' : nextBedId ? 'ALLOCATED' : 'WAITING',
          resolvedAt: updated.status === 'Discharged' || nextBedId ? new Date() : null,
        },
      });
    }

    return updated;
  });

  audit.record({
    action: 'PATIENT_UPDATED',
    auth,
    entity: 'Patient',
    entityId: result.patientNumber,
    detail: { message: `Operational record updated for ${result.patientNumber}`, tone: 'info' },
  });

  emit(EVENTS.QUEUE_UPDATED, { patientId: result.patientNumber, action: 'UPDATED' }, { rooms: QUEUE_ROOMS });
  if (result.assignedBedId) {
    emit(EVENTS.BED_UPDATED, { bedId: result.assignedBedId, status: 'Occupied', patientId: result.patientNumber }, { rooms: QUEUE_ROOMS });
  }

  return result;
}

/**
 * Discharges a patient (§8 Discharge Patient).
 * Releases assigned bed, doctor, nurse, equipment, and marks queue closed.
 */
async function discharge({ auth, id, reason = 'Discharge confirmed by hospital staff' }) {
  const result = await prisma.$transaction(async (tx) => {
    const patient = await tx.patient.findFirst({
      where: { OR: [{ patientNumber: id }, { id }] },
      include: { queueEntry: true },
    });
    if (!patient) throw ApiError.notFound(`Patient ${id} was not found.`);

    // 1. Release assigned bed
    let releasedBedId = patient.assignedBedId;
    if (releasedBedId) {
      await tx.bed.update({
        where: { id: releasedBedId },
        data: {
          status: 'AVAILABLE',
          patientId: null,
          patientRef: null,
          heldFor: null,
          availableFrom: null,
          notes: `Released after discharge of ${patient.patientNumber}: ${reason}`,
        },
      });
    }

    // 2. Release assigned doctor
    if (patient.assignedDoctorId) {
      const doc = await tx.doctor.findUnique({ where: { id: patient.assignedDoctorId } });
      if (doc) {
        await tx.doctor.update({
          where: { id: doc.id },
          data: {
            patients: Math.max(0, doc.patients - 1),
            availability: doc.patients - 1 < doc.maxOperationalLoad ? 'Available' : doc.availability,
          },
        });
      }
    }

    // 3. Release assigned nurse
    if (patient.assignedNurseId) {
      const nurse = await tx.nurse.findUnique({ where: { id: patient.assignedNurseId } });
      if (nurse) {
        await tx.nurse.update({
          where: { id: nurse.id },
          data: {
            assignedPatients: Math.max(0, nurse.assignedPatients - 1),
            workload: nurse.assignedPatients - 1 >= nurse.maxOperationalLoad ? 'High' : 'Low',
          },
        });
      }
    }

    // 4. Release equipment reserved for this patient
    await tx.equipmentUnit.updateMany({
      where: { patientId: patient.patientNumber },
      data: {
        reserved: false,
        inUse: false,
        status: 'Available',
        reservedFor: null,
        patientId: null,
      },
    });

    // 5. Close queue entry
    if (patient.queueEntry) {
      await tx.patientQueue.update({
        where: { id: patient.queueEntry.id },
        data: {
          status: 'CLOSED',
          resolvedAt: new Date(),
        },
      });
    }

    // 6. Update patient status to DISCHARGED
    const discharged = await tx.patient.update({
      where: { id: patient.id },
      data: {
        status: 'Discharged',
        assignedBedId: null,
        notes: patient.notes ? `${patient.notes} | ${reason}` : reason,
      },
    });

    return { patient: discharged, releasedBedId };
  });

  audit.record({
    action: 'PATIENT_DISCHARGED',
    auth,
    entity: 'Patient',
    entityId: result.patient.patientNumber,
    detail: { message: `Patient ${result.patient.patientNumber} discharged — ${reason}`, tone: 'info' },
  });

  emit(EVENTS.QUEUE_UPDATED, { patientId: result.patient.patientNumber, action: 'DISCHARGED' }, { rooms: QUEUE_ROOMS });
  if (result.releasedBedId) {
    emit(EVENTS.BED_UPDATED, { bedId: result.releasedBedId, status: 'Available' }, { rooms: QUEUE_ROOMS });
  }

  return {
    patient: result.patient,
    status: result.patient.status,
    patientNumber: result.patient.patientNumber,
    releasedBedId: result.releasedBedId,
    dischargedAt: new Date(),
    reason,
  };
}

/**
 * Records a clinical requirement against a patient (the treating clinician
 * states what the patient needs — MediCore never derives it from a diagnosis).
 */
async function recordRequirement({ auth, id, requirement, note }) {
  const patient = await prisma.patient.findFirst({
    where: { OR: [{ patientNumber: id }, { id }] },
  });
  if (!patient) throw ApiError.notFound(`Patient ${id} was not found.`);

  const updated = await prisma.patient.update({
    where: { id: patient.id },
    data: {
      requiredResource: requirement || patient.requiredResource,
      notes: note || patient.notes,
      clinicalRequirementBy: auth.staffRef ? `${auth.name} · ${auth.staffRef}` : auth.name,
      requirementConfirmedAt: new Date(),
    },
  });

  const queueEntry = await prisma.patientQueue.findUnique({ where: { patientId: patient.id } });
  if (queueEntry && requirement) {
    await prisma.patientQueue.update({ where: { id: queueEntry.id }, data: { requiredResource: requirement } });
  }

  return { id: updated.patientNumber, requiredResource: updated.requiredResource, confirmedBy: updated.clinicalRequirementBy };
}

module.exports = { list, mine, getById, recordRequirement, toRows, create, update, discharge };

