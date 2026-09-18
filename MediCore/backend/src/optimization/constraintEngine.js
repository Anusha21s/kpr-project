/**
 * Constraint engine (§26).
 *
 * Detects operational conflicts between demand and capacity. Every conflict
 * reports resource, currentCapacity, demand, gap, severity and the patients
 * affected — no clinical judgement is made anywhere in this file (§52).
 */

const { calculateHospitalMetrics } = require('../services/metricsService');
const { NURSE_WORKLOAD_LIMIT } = require('../../seeds/constants');

const MULTI_RESOURCE_REQUIREMENT = 'ICU · OT · Specialist · Nursing support · Ventilator';

/**
 * A patient with two or more simultaneous resource requirements is treated as
 * ONE multi-resource case — never as independent single-resource problems (§27).
 */
function findMultiResourceCase(state) {
  const candidates = state.queue
    .filter((entry) => {
      const requirements = [
        entry.requiredResource,
        entry.secondaryResource,
        entry.requiresVentilator ? 'Ventilator' : null,
        entry.needsOt ? 'OT' : null,
        entry.specialtyRequired,
      ].filter(Boolean);
      return requirements.length >= 4;
    })
    .sort((a, b) => {
      const rank = { Critical: 0, High: 1, Medium: 2, Low: 3 };
      if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
      return b.waitingMinutes - a.waitingMinutes;
    });
  return candidates[0] || null;
}

/**
 * Detects every open conflict for a state.
 * @returns {Array} conflicts in the shape the dashboards render.
 */
function detectConflicts(state, metrics = calculateHospitalMetrics(state)) {
  const demand = metrics.queue;
  const conflicts = [];
  const icuWard = metrics.beds.wards.find((ward) => ward.id === 'icu') || { available: 0, committed: 0, units: 0 };
  const emergencyWard = metrics.beds.wards.find((ward) => ward.id === 'emergency') || { available: 0 };
  const generalWard = metrics.beds.wards.find((ward) => ward.id === 'general') || { available: 0 };
  const ventilators = metrics.equipment.ventilators;
  const freeVentilators = ventilators ? ventilators.free : 0;
  const freeOtRooms = metrics.ot.rooms.filter((room) => room.status === 'Available').length;

  /* ---------------------------------------------- CFL-01 multi-resource case */
  const conflictCase = findMultiResourceCase(state);
  if (conflictCase) {
    const anaesthetists = state.doctors.filter((doctor) => doctor.specialty === 'Anaesthesiology');
    const anaesthetistAvailable = anaesthetists.some(
      (doctor) => doctor.dutyStatus === 'ON_DUTY' && doctor.availability === 'Available',
    );
    const resourceRows = [
      {
        resource: 'ICU bed',
        value: `${icuWard.available} vacant of ${icuWard.units}`,
        status: icuWard.available > 0 ? 'Success' : 'Critical',
      },
      {
        resource: 'Operating theatre',
        value: `${freeOtRooms} free · ${metrics.ot.maintenance} under maintenance`,
        status: freeOtRooms > 0 ? 'Success' : 'Critical',
      },
      {
        resource: 'Specialist support',
        value: `${conflictCase.specialtyRequired || 'Specialist'} — ${anaesthetistAvailable ? 'on-duty cover available' : 'no on-duty cover'} · ${metrics.doctors.available} doctors available`,
        status: metrics.doctors.available > 0 ? 'Success' : 'Critical',
      },
      {
        resource: 'Nursing support',
        value: `${metrics.nurses.available} available · ${metrics.nurses.atConstraint} at workload limit`,
        status: metrics.nurses.atConstraint > 0 ? 'Critical' : 'Success',
      },
      {
        resource: 'Ventilator',
        value: `${freeVentilators} uncommitted · ${demand.ventilatorRequests} cases require ventilation`,
        status: freeVentilators >= 2 ? 'Success' : 'Critical',
      },
    ];

    conflicts.push({
      id: 'CFL-01',
      type: 'MULTI_RESOURCE_CONFLICT',
      severity: 'Critical',
      title: 'MULTI-RESOURCE CONFLICT',
      caseId: conflictCase.id,
      caseLabel: `${conflictCase.id} · ${conflictCase.age}y ${conflictCase.sex} · ${conflictCase.priority}`,
      requirement: MULTI_RESOURCE_REQUIREMENT,
      summary: `${conflictCase.id} requires ICU, theatre, specialist, nursing and ventilator support simultaneously.`,
      detectedAt: new Date(),
      affectedPatients: [conflictCase.id],
      resources: resourceRows,
      blockedResources: resourceRows.filter((row) => row.status === 'Critical').map((row) => row.resource),
      actions: [
        'Review OT schedule with the theatre coordinator',
        'Check ICU capacity and escalation bays',
        'Check specialist duty roster',
        'Check equipment availability',
        'Review escalation / transfer pathway with authorized staff',
      ],
      principleNote:
        'MediCore does not cancel another patient’s treatment, discharge a patient or move anyone automatically. These are review actions for the coordinating team.',
      linkedRecommendations: ['REC-ICU-01', 'REC-OT-01', 'REC-NUR-01', 'REC-EQP-01'],
      status: 'Open',
    });
  }

  /* ------------------------------------------------ capacity gap conflicts */
  const capacityConflicts = [
    {
      id: 'CFL-02',
      resource: 'ICU Capacity',
      demand: demand.icuRequests,
      capacity: icuWard.available,
      unit: 'ICU beds',
      detail: 'ICU requests exceed vacant ICU beds. Escalation or transfer review required by authorized staff.',
      linked: ['REC-ICU-01', 'REC-NUR-01'],
    },
    {
      id: 'CFL-03',
      resource: 'Emergency Beds',
      demand: demand.emergencyBedRequests,
      capacity: emergencyWard.available,
      unit: 'emergency bays',
      detail: 'Monitored emergency bay demand exceeds vacant bays. Overflow capacity or step-down review required.',
      linked: ['REC-BED-01', 'REC-EMG-01'],
    },
    {
      id: 'CFL-04',
      resource: 'OT Capacity',
      demand: Math.max(state.otBacklog.length, 1),
      capacity: freeOtRooms,
      unit: 'theatres',
      detail: 'Surgical requests exceed free theatres. Schedule review with the theatre coordinator required.',
      linked: ['REC-OT-01'],
    },
    {
      id: 'CFL-06',
      resource: 'General Beds',
      demand: demand.generalBedRequests,
      capacity: generalWard.available,
      unit: 'general beds',
      detail: 'General bed demand exceeds vacant beds. Ward capacity review required.',
      linked: ['REC-BED-01'],
    },
    {
      id: 'CFL-07',
      resource: 'Ventilators',
      demand: demand.ventilatorRequests,
      capacity: freeVentilators,
      unit: 'ventilators',
      detail: 'Ventilation demand exceeds uncommitted ventilator units. Equipment review required.',
      linked: ['REC-EQP-01'],
    },
  ];

  capacityConflicts.forEach((entry) => {
    if (entry.demand <= entry.capacity) return;
    const gap = entry.demand - entry.capacity;
    conflicts.push({
      id: entry.id,
      type: 'CAPACITY_SHORTFALL',
      resource: entry.resource,
      severity: gap >= 3 ? 'Critical' : 'Operational',
      title: `${entry.resource} shortfall`,
      summary: `${gap} ${entry.unit} short — ${entry.demand} required against ${entry.capacity} free.`,
      detail: entry.detail,
      demand: entry.demand,
      capacity: entry.capacity,
      gap,
      detectedAt: new Date(),
      affectedPatients: state.queue
        .filter((patient) => {
          if (entry.resource === 'ICU Capacity') return patient.requiredResource === 'ICU Bed' || patient.secondaryResource === 'ICU Bed';
          if (entry.resource === 'Emergency Beds') return patient.requiredResource === 'Emergency Bed';
          if (entry.resource === 'General Beds') return patient.requiredResource === 'General Bed';
          if (entry.resource === 'Ventilators') return patient.requiresVentilator;
          return patient.needsOt;
        })
        .map((patient) => patient.id),
      actions: [
        entry.resource === 'ICU Capacity' ? 'Check ICU capacity and escalation bays' : null,
        entry.resource === 'Emergency Beds' ? 'Review step-down route with clinical staff' : null,
        entry.resource === 'General Beds' ? 'Review ward capacity and cleaning turnaround' : null,
        entry.resource === 'OT Capacity' ? 'Review OT schedule with the theatre coordinator' : null,
        entry.resource === 'Ventilators' ? 'Check equipment availability and holds' : null,
        'Escalate to the authorized coordinator if the gap persists',
      ].filter(Boolean),
      linkedRecommendations: entry.linked,
      status: 'Open',
    });
  });

  /* ------------------------------------------------ staffing conflicts */
  if (metrics.nurses.atConstraint > 0 || metrics.nurses.workloadIndex >= 75) {
    conflicts.push({
      id: 'CFL-05',
      type: 'WORKLOAD_CONSTRAINT',
      resource: 'Nursing',
      severity: 'Operational',
      title: 'Nursing workload constraint',
      summary: `${metrics.nurses.atConstraint} nurses are at the ${NURSE_WORKLOAD_LIMIT}-patient workload limit; overall nursing workload index is ${metrics.nurses.workloadIndex}.`,
      detail: 'Assignment beyond the configured constraint requires coordinator approval and is flagged as out of policy.',
      demand: metrics.nurses.atConstraint,
      capacity: metrics.nurses.available,
      gap: Math.max(0, metrics.nurses.atConstraint - metrics.nurses.available),
      detectedAt: new Date(),
      affectedPatients: [],
      actions: ['Check the nursing roster', 'Deploy available nurses', 'Request off-shift reinforcement'],
      linkedRecommendations: ['REC-NUR-01'],
      status: 'Open',
    });
  }

  /* ------------------- duty conflicts: queue demand with no eligible staff */
  const dutyGaps = Array.from(
    state.queue.reduce((accumulator, entry) => {
      if (!entry.specialtyRequired) return accumulator;
      const eligible = state.doctors.some(
        (doctor) =>
          doctor.specialty === entry.specialtyRequired &&
          doctor.dutyStatus === 'ON_DUTY' &&
          doctor.availability === 'Available',
      );
      if (!eligible) accumulator.set(entry.specialtyRequired, (accumulator.get(entry.specialtyRequired) || 0) + 1);
      return accumulator;
    }, new Map()),
  );

  if (dutyGaps.length) {
    conflicts.push({
      id: 'CFL-08',
      type: 'DOCTOR_DUTY_CONFLICT',
      resource: 'Medical Staff',
      severity: 'Operational',
      title: 'Specialist duty conflict',
      summary: dutyGaps
        .map(([specialty, count]) => `${specialty}: ${count} request(s) with no on-duty available doctor`)
        .join(' · '),
      detail:
        'Requests exist for specialties with no on-duty, available doctor. Off-duty staff must never be proposed silently — an escalation request is required.',
      demand: dutyGaps.reduce((sum, [, count]) => sum + count, 0),
      capacity: 0,
      gap: dutyGaps.reduce((sum, [, count]) => sum + count, 0),
      detectedAt: new Date(),
      affectedPatients: state.queue
        .filter((entry) => dutyGaps.some(([specialty]) => specialty === entry.specialtyRequired))
        .map((entry) => entry.id),
      actions: ['Check the specialist duty roster', 'Raise an escalation / call-in request with authorized staff'],
      linkedRecommendations: ['REC-DOC-01'],
      status: 'Open',
    });
  }

  return conflicts;
}

module.exports = { detectConflicts, findMultiResourceCase, MULTI_RESOURCE_REQUIREMENT };
