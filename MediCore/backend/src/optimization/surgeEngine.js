/**
 * Surge engine (§28–30).
 *
 * The surge scenario is deterministic: the same baseline always produces the
 * same mass-casualty intake, the same provisional bed holds and the same
 * before / after comparison. Nothing here is applied to the live hospital
 * tables — the projection is stored with the simulation and is fully
 * reversible.
 */

const { SURGE_PATIENTS } = require('../../seeds/patients');
const { buildSnapshot, calculateHospitalMetrics, calculateResourcePressure } = require('../services/metricsService');
const { detectConflicts } = require('./constraintEngine');

const PRIORITY_WINDOW = {
  Critical: 15,
  High: 30,
  Medium: 60,
  Low: 120,
};

/** Provisional holds opened by the intake — a hold is not a clinical decision. */
function planBedHolds(state, intake) {
  const criticalIcu = intake.filter((entry) => entry.requiredResource === 'ICU Bed').length;
  const emergency = intake.filter((entry) => entry.requiredResource === 'Emergency Bed').length;
  const general = intake.filter((entry) => entry.requiredResource === 'General Bed').length;
  const holds = [];

  const take = (wardId, count, reason) => {
    let remaining = count;
    state.bedUnits.forEach((unit) => {
      if (remaining > 0 && unit.wardId === wardId && unit.status === 'Available') {
        remaining -= 1;
        holds.push({ bedId: unit.id, wardId, heldFor: reason });
      }
    });
  };

  take('emergency', Math.min(2, emergency), 'Held for incoming critical emergency arrivals');
  take('general', Math.min(7, general || 3), 'Held for surge admissions and emergency step-down transfers');
  take('icu', Math.min(1, criticalIcu), 'Committed to the highest-acuity ICU case in the intake');

  return holds;
}

/** Emergency-resource adjustments during intake (monitored capacity pressure). */
function planEmergencyResourceAdjustments(state) {
  return state.emergencyResources
    .map((resource) => {
      if (resource.id === 'resus' && resource.total - resource.inUse > 0) {
        return { id: resource.id, inUseDelta: 1, heldFor: 'Resuscitation bay held for an incoming critical arrival' };
      }
      if (resource.id === 'trauma' && resource.total - resource.inUse > 1) {
        return { id: resource.id, inUseDelta: 2, heldFor: 'Trauma sets staged for the intake' };
      }
      if (resource.id === 'ambulances') {
        return { id: resource.id, inUseDelta: 0, heldFor: 'One additional ambulance placed on standby for surge intake' };
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * Builds the surge batch rows for a simulation.
 * Patient numbers continue the P-series so the intake is traceable.
 */
function buildIntake({ patientCount = 20, offset = 8 } = {}) {
  return SURGE_PATIENTS.slice(0, patientCount).map((patient, index) => {
    const number = index + 1 + offset;
    return {
      ...patient,
      patientNumber: `P${String(number).padStart(3, '0')}`,
      waitingMinutes: Math.max(0, patient.createdMinutes ?? (patient.priority === 'Critical' ? 4 + index : 0)),
      triageWindowMinutes: PRIORITY_WINDOW[patient.priority] || 60,
    };
  });
}

/**
 * Pure projection: baseline state + intake → the surge picture with
 * before/after snapshots, changes and conflicts.
 */
function projectSurge(state, intake) {
  const before = buildSnapshot(state, 'Baseline');
  const queuedIntake = intake.map((entry, index) => ({
    id: entry.patientNumber,
    patientId: entry.patientNumber,
    name: entry.name,
    age: entry.age,
    sex: entry.sex,
    department: 'Emergency',
    priority: entry.priority,
    triage: entry.triage,
    requiredResource: entry.requiredResource,
    secondaryResource: entry.secondaryResource,
    specialtyRequired: entry.specialtyRequired,
    requiresVentilator: entry.requiresVentilator,
    needsOt: entry.needsOt,
    waitingMinutes: entry.waitingMinutes,
    status: 'Waiting',
    position: state.queue.length + index + 1,
    clinicalRequirementBy: entry.clinicalRequirementBy,
    notes: entry.notes,
    securedResources: [],
    simulated: true,
  }));

  const surgeState = { ...state, queue: [...state.queue, ...queuedIntake] };
  const holds = planBedHolds(state, intake);
  const projectedBeds = state.bedUnits.map((unit) => {
    const hold = holds.find((entry) => entry.bedId === unit.id);
    return hold ? { ...unit, status: 'Reserved', heldFor: hold.heldFor } : unit;
  });
  const adjustments = planEmergencyResourceAdjustments(state);
  const projectedResources = state.emergencyResources.map((resource) => {
    const adjustment = adjustments.find((entry) => entry.id === resource.id);
    if (!adjustment) return resource;
    return {
      ...resource,
      inUse: Math.min(resource.total, resource.inUse + (adjustment.inUseDelta || 0)),
      heldFor: adjustment.heldFor || resource.heldFor,
    };
  });

  const projected = { ...surgeState, bedUnits: projectedBeds, emergencyResources: projectedResources };
  const metrics = calculateHospitalMetrics(projected);
  const conflicts = detectConflicts(projected, metrics);
  const pressure = calculateResourcePressure(projected);
  const after = buildSnapshot({ ...projected, conflicts }, 'Surge');

  const changes = {
    queue: {
      before: before.emergencyQueue,
      after: after.emergencyQueue,
      criticalBefore: before.criticalQueue,
      criticalAfter: after.criticalQueue,
      unit: 'patients',
    },
    beds: {
      before: before.availableBeds,
      after: after.availableBeds,
      occupancyBefore: metrics.beds.occupancyPercentage,
      unit: 'beds',
    },
    icu: {
      before: before.icuAvailable,
      after: after.icuAvailable,
      occupancy: metrics.beds.icu.occupancyPercentage,
      requests: metrics.queue.icuRequests,
      unit: 'beds',
    },
    doctors: {
      availableBefore: before.doctorsAvailable,
      availableAfter: after.doctorsAvailable,
      workloadBefore: before.doctorWorkload,
      workloadAfter: after.doctorWorkload,
      unit: 'doctors',
    },
    nurses: {
      availableBefore: before.nursesAvailable,
      availableAfter: after.nursesAvailable,
      workloadBefore: before.nurseWorkload,
      workloadAfter: after.nurseWorkload,
      atConstraint: metrics.nurses.atConstraint,
      unit: 'nurses',
    },
    equipment: {
      utilisationBefore: before.equipmentUtilisation,
      utilisationAfter: after.equipmentUtilisation,
      ventilatorsBefore: before.ventilatorsAvailable,
      ventilatorsAfter: after.ventilatorsAvailable,
      unit: '%',
    },
    ot: {
      availableBefore: before.otAvailable,
      availableAfter: after.otAvailable,
      requests: metrics.ot.scheduled + metrics.ot.ongoing,
      unit: 'theatres',
    },
  };

  return {
    before,
    after,
    changes,
    conflicts,
    intake: queuedIntake,
    metrics: { beds: metrics.beds, queue: metrics.queue, nurses: metrics.nurses, doctors: metrics.doctors },
    pressure,
    projection: {
      bedHolds: holds,
      emergencyResourceAdjustments: adjustments,
    },
  };
}

/**
 * Convenience entry point: baseline state → full surge projection.
 * Named after the frontend engine call so both layers read the same way.
 */
const simulateEmergencySurge = (state, { patientCount = 20, offset = 8 } = {}) =>
  projectSurge(state, buildIntake({ patientCount, offset }));

module.exports = {
  buildIntake,
  projectSurge,
  simulateEmergencySurge,
  planBedHolds,
  planEmergencyResourceAdjustments,
  PRIORITY_WINDOW,
};
