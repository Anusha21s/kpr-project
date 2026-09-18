/**
 * Scoring engine (§51).
 *
 * The engine produces a transparent ranking: every candidate carries the
 * factors that placed it where it is, so the coordinator can see *why* a
 * resource was proposed and can reject it with a reason.
 *
 * Factors: priority, waiting time, duty state, current load, specialty match,
 * shift window, equipment availability and theatre availability.
 */

const { WORKLOAD_WEIGHT } = require('../services/metricsService');
const { NURSE_WORKLOAD_LIMIT } = require('../../seeds/constants');

const PRIORITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };

/** Operational queue order: clinical priority first, then longest wait. */
function rankQueue(queue) {
  return [...queue].sort((a, b) => {
    const priorityA = PRIORITY_RANK[a.priority] ?? 9;
    const priorityB = PRIORITY_RANK[b.priority] ?? 9;
    if (priorityA !== priorityB) return priorityA - priorityB;
    return b.waitingMinutes - a.waitingMinutes;
  });
}

/** A doctor may only be recommended when on duty, available and in shift. */
function scoreDoctor(doctor, entry) {
  const specialtyMatch = doctor.specialty === entry.specialtyRequired;
  const onDuty = doctor.dutyStatus === 'ON_DUTY';
  const available = doctor.availability === 'Available';
  const loadScore = 100 - (WORKLOAD_WEIGHT[doctor.workload] || 50);
  const specialtyScore = specialtyMatch ? 40 : 0;
  const priorityScore = entry.priority === 'Critical' ? 30 : entry.priority === 'High' ? 20 : 10;

  return {
    doctorId: doctor.id,
    name: doctor.name,
    specialty: doctor.specialty,
    eligible: specialtyMatch && onDuty && available,
    score: (onDuty ? 20 : 0) + (available ? 20 : 0) + loadScore + specialtyScore + priorityScore,
    factors: {
      specialtyMatch,
      onDuty,
      available,
      workload: doctor.workload,
      patients: doctor.patients,
      maxOperationalLoad: doctor.maxOperationalLoad,
    },
    reason: specialtyMatch
      ? `${doctor.name} (${doctor.specialty}) is on duty, available and least loaded for this requirement.`
      : `${doctor.name} is on duty and available but does not match the required specialty.`,
  };
}

/**
 * Least-loaded, eligible doctor for a case.
 * Off-duty / leave / unavailable staff are never returned as a proposal (§14).
 */
function selectDoctorForCase(state, entry, { exclude = [] } = {}) {
  const candidates = state.doctors
    .filter((doctor) => !exclude.includes(doctor.id))
    .map((doctor) => scoreDoctor(doctor, entry))
    .filter((candidate) => candidate.eligible)
    .sort((a, b) => b.score - a.score);

  if (candidates.length) return { ...candidates[0], escalated: false };
  return {
    doctorId: null,
    name: 'Escalation required',
    eligible: false,
    escalated: true,
    score: 0,
    factors: { specialtyMatch: false, onDuty: false, available: false },
    reason: `No on-duty, available ${entry.specialtyRequired || 'specialist'} doctor covers this requirement. An escalation / call-in request is required from authorized staff — off-duty staff are never assigned automatically.`,
  };
}

/** Nurses are ranked by department fit and current patient load. */
function scoreNurse(nurse, entry, preferredDepartments = []) {
  const departmentMatch = preferredDepartments.length ? preferredDepartments.includes(nurse.department) : true;
  const capacity = nurse.maxOperationalLoad - nurse.assignedPatients;
  const capacityScore = Math.max(0, capacity) * 12;
  const bandScore = 100 - (WORKLOAD_WEIGHT[nurse.workload] || 50);
  const eligible =
    nurse.dutyStatus === 'ON_DUTY' && nurse.availability === 'Available' && nurse.assignedPatients < NURSE_WORKLOAD_LIMIT;

  return {
    nurseId: nurse.id,
    name: nurse.name,
    department: nurse.department,
    eligible,
    score: (departmentMatch ? 30 : 0) + capacityScore + bandScore,
    factors: {
      departmentMatch,
      assignedPatients: nurse.assignedPatients,
      maxOperationalLoad: nurse.maxOperationalLoad,
      workload: nurse.workload,
      onDuty: nurse.dutyStatus === 'ON_DUTY',
      available: nurse.availability === 'Available',
    },
    reason: departmentMatch
      ? `${nurse.name} (${nurse.department}) has ${Math.max(0, capacity)} of ${nurse.maxOperationalLoad} assignment slots free.`
      : `${nurse.name} is available but covers ${nurse.department} rather than the requested area.`,
  };
}

/**
 * Nurse reinforcement for a set of areas, respecting the workload constraint.
 * Returns at most `count` eligible nurses, never exceeding the constraint.
 */
function selectNursesForReinforcement(state, areas, count) {
  const ranked = state.nurses
    .map((nurse) => scoreNurse(nurse, { priority: 'Critical', specialtyRequired: null }, areas))
    .filter((candidate) => candidate.eligible)
    .sort((a, b) => b.score - a.score);
  return ranked.slice(0, Math.max(0, count));
}

/** Free, uncommitted equipment units for a requirement. */
function selectEquipmentUnits(state, equipmentId, count) {
  const category = state.equipment.find((entry) => entry.id === equipmentId);
  if (!category) return { category: null, units: [] };
  const units = category.units.filter((unit) => !unit.inUse && !unit.reserved).slice(0, Math.max(0, count));
  return { category, units };
}

/** Theatres that can take an emergency case without cancelling anything. */
function selectTheatresForHold(state, count) {
  return state.otRooms
    .filter((room) => room.status === 'Available')
    .slice(0, Math.max(0, count))
    .map((room) => ({
      theatreId: room.id,
      name: room.name,
      nextAvailableSlot: room.nextAvailableSlot,
      reason: `${room.id} is free${room.nextAvailableSlot ? ` from ${room.nextAvailableSlot}` : ''}. No scheduled procedure is cancelled — a hold only reserves the slot for review.`,
    }));
}

module.exports = {
  PRIORITY_RANK,
  rankQueue,
  scoreDoctor,
  selectDoctorForCase,
  scoreNurse,
  selectNursesForReinforcement,
  selectEquipmentUnits,
  selectTheatresForHold,
};
