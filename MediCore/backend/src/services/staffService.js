/**
 * Staff service (§16, §22, §42).
 *
 * Duty status (ON_DUTY | OFF_DUTY | LEAVE | UNAVAILABLE) and availability are
 * operational facts owned by the roster. They are what the optimizer reads and
 * what the availability events broadcast — a change here immediately changes
 * who can be proposed for a case.
 */

const { prisma } = require('../config/database');
const { loadState } = require('../repositories/hospitalStateRepository');
const { calculateStaffAnalysis } = require('./metricsService');
const { ApiError } = require('../utils/ApiError');
const { emit, room, EVENTS } = require('../socket/bus');
const audit = require('./auditService');

const DUTY_CODES = ['ON_DUTY', 'OFF_DUTY', 'LEAVE', 'UNAVAILABLE'];
const AVAILABILITY_CODES = ['Available', 'Assigned', 'InProcedure', 'Unavailable'];

const STAFF_ROOMS = [room.role('command_center'), room.role('resource_coordinator')];

async function listDoctors({ query = {} } = {}) {
  const state = await loadState({ simulationId: 'auto' });
  let doctors = state.doctors;
  if (query.duty) doctors = doctors.filter((doctor) => doctor.dutyStatus === query.duty);
  if (query.specialty) doctors = doctors.filter((doctor) => doctor.specialty === query.specialty);
  if (query.available === 'true' || query.available === true) {
    doctors = doctors.filter((doctor) => doctor.dutyStatus === 'ON_DUTY' && doctor.availability === 'Available');
  }
  if (query.search) {
    const term = String(query.search).toLowerCase();
    doctors = doctors.filter((doctor) =>
      [doctor.name, doctor.specialty, doctor.id].some((field) => String(field).toLowerCase().includes(term)),
    );
  }
  return {
    doctors,
    total: doctors.length,
    summary: calculateStaffAnalysis(state.doctors, state.nurses).doctors,
    shift: state.meta.shift,
  };
}

async function listNurses({ query = {} } = {}) {
  const state = await loadState({ simulationId: 'auto' });
  let nurses = state.nurses;
  if (query.duty) nurses = nurses.filter((nurse) => nurse.dutyStatus === query.duty);
  if (query.department) nurses = nurses.filter((nurse) => nurse.department === query.department);
  if (query.available === 'true' || query.available === true) {
    nurses = nurses.filter((nurse) => nurse.dutyStatus === 'ON_DUTY' && nurse.availability === 'Available');
  }
  if (query.search) {
    const term = String(query.search).toLowerCase();
    nurses = nurses.filter((nurse) => [nurse.name, nurse.department, nurse.id].some((field) => String(field).toLowerCase().includes(term)));
  }
  return {
    nurses,
    total: nurses.length,
    summary: calculateStaffAnalysis(state.doctors, state.nurses).nurses,
    shift: state.meta.shift,
  };
}

/** The signed-in clinician's own duty record plus the tasks they own. */
async function myDuty({ auth }) {
  const state = await loadState({ simulationId: 'auto' });
  const tasks = Object.values(state.clinicalTasks);
  const record =
    auth.role === 'doctor'
      ? state.doctors.find((doctor) => doctor.id === auth.staffRef)
      : auth.role === 'nurse'
        ? state.nurses.find((nurse) => nurse.id === auth.staffRef)
        : null;

  return {
    role: auth.role,
    staff: record || { id: auth.staffRef, name: auth.name, role: auth.role },
    shift: state.meta.shift,
    tasks: tasks.filter((task) => task.assignedDoctorId === auth.staffRef || task.assignedNurseId === auth.staffRef),
    metrics: calculateStaffAnalysis(state.doctors, state.nurses),
    generatedAt: new Date(),
  };
}

async function setDoctorDuty({ auth, id, dutyStatus, availability, currentAssignment, rationale = null }) {
  if (dutyStatus && !DUTY_CODES.includes(dutyStatus)) throw ApiError.validation(`Unsupported duty status "${dutyStatus}".`);
  if (availability && !AVAILABILITY_CODES.includes(availability)) {
    throw ApiError.validation(`Unsupported availability "${availability}".`);
  }

  /* Doctor.id *is* the roster reference (DOC-1042 …) — there is no separate column. */
  const doctor = await prisma.doctor.findUnique({ where: { id } });
  if (!doctor) throw ApiError.notFound(`Doctor ${id} was not found.`);

  const nextDuty = dutyStatus || doctor.dutyStatus;
  const nextAvailability =
    nextDuty !== 'ON_DUTY' ? 'Unavailable' : availability || (doctor.availability === 'Unavailable' ? 'Available' : doctor.availability);

  const updated = await prisma.doctor.update({
    where: { id: doctor.id },
    data: {
      dutyStatus: nextDuty,
      availability: nextAvailability,
      currentAssignment: nextDuty === 'ON_DUTY' ? currentAssignment ?? doctor.currentAssignment : 'Out of shift',
      since: new Date().toISOString().slice(11, 16),
    },
  });

  const dutyDate = new Date();
  dutyDate.setHours(0, 0, 0, 0);
  await prisma.doctorDuty.upsert({
    where: {
      doctorId_shiftBlock_dutyDate: {
        doctorId: doctor.id,
        shiftBlock: doctor.shiftBlock || 'MORNING',
        dutyDate,
      },
    },
    update: { status: nextDuty, note: rationale, shiftLabel: doctor.shift || '' },
    create: {
      doctorId: doctor.id,
      shiftBlock: doctor.shiftBlock || 'MORNING',
      shiftLabel: doctor.shift || '',
      dutyDate,
      status: nextDuty,
      note: rationale,
    },
  });

  audit.record({
    action: 'DOCTOR_DUTY_CHANGED',
    auth,
    entity: 'Doctor',
    entityId: doctor.id,
    detail: {
      message: `${doctor.name} (${doctor.id}) — ${nextDuty}${rationale ? ` · ${rationale}` : ''}`,
      tone: nextDuty === 'ON_DUTY' ? 'success' : 'info',
    },
  });

  emit(
    EVENTS.DOCTOR_AVAILABILITY,
    { doctorId: doctor.id, dutyStatus: nextDuty, availability: nextAvailability },
    { rooms: [...STAFF_ROOMS, doctor.userId ? room.user(doctor.userId) : null, room.department(doctor.department)].filter(Boolean) },
  );

  return {
    id: updated.id,
    name: updated.name,
    dutyStatus: updated.dutyStatus,
    availability: updated.availability,
    currentAssignment: updated.currentAssignment,
  };
}

async function setNurseDuty({ auth, id, dutyStatus, availability, currentAssignment, rationale = null }) {
  if (dutyStatus && !DUTY_CODES.includes(dutyStatus)) throw ApiError.validation(`Unsupported duty status "${dutyStatus}".`);
  if (availability && !AVAILABILITY_CODES.includes(availability)) {
    throw ApiError.validation(`Unsupported availability "${availability}".`);
  }

  const nurse = await prisma.nurse.findUnique({ where: { id } });
  if (!nurse) throw ApiError.notFound(`Nurse ${id} was not found.`);

  const nextDuty = dutyStatus || nurse.dutyStatus;
  const nextAvailability = nextDuty !== 'ON_DUTY' ? 'Unavailable' : availability || nurse.availability;

  const updated = await prisma.nurse.update({
    where: { id: nurse.id },
    data: {
      dutyStatus: nextDuty,
      availability: nextAvailability,
      currentAssignment: nextDuty === 'ON_DUTY' ? currentAssignment ?? nurse.currentAssignment : 'Out of shift',
    },
  });

  const nurseDutyDate = new Date();
  nurseDutyDate.setHours(0, 0, 0, 0);
  await prisma.nurseDuty.upsert({
    where: {
      nurseId_shiftBlock_dutyDate: {
        nurseId: nurse.id,
        shiftBlock: nurse.shiftBlock || 'MORNING',
        dutyDate: nurseDutyDate,
      },
    },
    update: { status: nextDuty, note: rationale, shiftLabel: nurse.shift || '' },
    create: {
      nurseId: nurse.id,
      shiftBlock: nurse.shiftBlock || 'MORNING',
      shiftLabel: nurse.shift || '',
      dutyDate: nurseDutyDate,
      status: nextDuty,
      note: rationale,
    },
  });

  audit.record({
    action: 'NURSE_DUTY_CHANGED',
    auth,
    entity: 'Nurse',
    entityId: nurse.id,
    detail: {
      message: `${nurse.name} (${nurse.id}) — ${nextDuty}${rationale ? ` · ${rationale}` : ''}`,
      tone: nextDuty === 'ON_DUTY' ? 'success' : 'info',
    },
  });

  emit(
    EVENTS.NURSE_AVAILABILITY,
    { nurseId: nurse.id, dutyStatus: nextDuty, availability: nextAvailability },
    { rooms: [...STAFF_ROOMS, nurse.userId ? room.user(nurse.userId) : null, room.department(nurse.department)].filter(Boolean) },
  );

  return {
    id: updated.id,
    name: updated.name,
    dutyStatus: updated.dutyStatus,
    availability: updated.availability,
    currentAssignment: updated.currentAssignment,
  };
}

/** Roster view: duty rows for the current shift window. */
async function roster({ date = new Date() } = {}) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const [doctorDuty, nurseDuty] = await Promise.all([
    prisma.doctorDuty.findMany({
      where: { dutyDate: start },
      include: { doctor: { select: { name: true, specialty: true, availability: true, currentAssignment: true } } },
    }),
    prisma.nurseDuty.findMany({
      where: { dutyDate: start },
      include: { nurse: { select: { name: true, department: true, availability: true, assignedPatients: true, currentAssignment: true } } },
    }),
  ]);
  return {
    date: start,
    doctors: doctorDuty.map((row) => ({
      id: row.doctorId,
      name: row.doctor.name,
      specialty: row.doctor.specialty,
      dutyStatus: row.status,
      availability: row.doctor.availability,
      currentAssignment: row.doctor.currentAssignment,
      note: row.note,
      shift: row.shiftLabel,
      shiftBlock: row.shiftBlock,
    })),
    nurses: nurseDuty.map((row) => ({
      id: row.nurseId,
      name: row.nurse.name,
      department: row.nurse.department,
      dutyStatus: row.status,
      availability: row.nurse.availability,
      assignedPatients: row.nurse.assignedPatients,
      currentAssignment: row.nurse.currentAssignment,
      note: row.note,
      shift: row.shiftLabel,
      shiftBlock: row.shiftBlock,
    })),
  };
}

module.exports = { listDoctors, listNurses, myDuty, setDoctorDuty, setNurseDuty, roster };
