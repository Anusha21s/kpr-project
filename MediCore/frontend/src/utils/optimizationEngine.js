/**
 * MediCore optimisation engine.
 *
 * A transparent, deterministic rule/constraint engine — no external API, no
 * machine-learning black box. It reads the current hospital state and:
 *
 *   1. ranks the patient queue by priority and waiting time
 *   2. measures demand against capacity for every resource class
 *   3. checks staff duty windows, availability and workload constraints
 *   4. checks equipment, theatre and emergency-resource availability
 *   5. detects cases where several constraints collide at once
 *   6. generates feasible, reviewable recommendations *together* (a change to
 *      general beds changes emergency-bed pressure, which changes nursing need)
 *   7. projects the operational impact of those recommendations
 *
 * The engine never decides clinical care, never moves a patient and never
 * cancels another patient's treatment. Every output is a recommendation that an
 * authorised coordinator must explicitly confirm.
 */

import {
  BED_STATUS,
  SURGE_OVERFLOW_BEDS,
  ESCALATION_BEDS,
} from '../data/beds';
import { NURSE_WORKLOAD_LIMIT } from '../data/nurses';
import { OT_BACKLOG } from '../data/otSchedules';
import { CONFLICT_CASE_ID } from '../data/patients';
import {
  calculateHospitalMetrics,
  calculateDemandProfile,
  buildSnapshot,
  calculateResourcePressure,
} from './simulationEngine';

export const PRIORITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };

/** Queue ordering rule: clinical priority first, then longest waiting. */
export function rankQueue(queue) {
  return [...queue].sort((a, b) => {
    const rank = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
    if (rank !== 0) return rank;
    return b.waitingMinutes - a.waitingMinutes;
  });
}

const isOnDuty = (member) => member.dutyStatus === 'ON_DUTY';
const isAvailable = (member) => isOnDuty(member) && member.availability === 'Available';

const WORKLOAD_SCORE = { Low: 1, Moderate: 2, High: 3 };

/* ------------------------------------------------------------------ *
 * Staff selection
 * ------------------------------------------------------------------ */

/**
 * Deployment rule for doctors: only doctors who are ON DUTY, Available and
 * inside their shift window can be recommended, ordered by current workload and
 * by how closely their specialty matches the surge demand profile.
 */
export function selectDoctorsForSurge(doctors, demandProfile, count = 3) {
  const specialtyNeed = demandProfile.specialistNeeds;
  const candidateRoles = [
    { role: 'Critical-care step-down support', specialty: 'General Medicine' },
    { role: 'Emergency fast-track assessment', specialty: 'Emergency Medicine' },
    { role: 'Respiratory support — ventilation demand', specialty: 'Pulmonology' },
    { role: 'Emergency monitored bays', specialty: 'Internal Medicine' },
  ];

  const eligible = doctors
    .filter(isAvailable)
    .sort((a, b) => {
      const needA = specialtyNeed[a.specialty] || 0;
      const needB = specialtyNeed[b.specialty] || 0;
      if (needB !== needA) return needB - needA;
      return (WORKLOAD_SCORE[a.workload] || 2) - (WORKLOAD_SCORE[b.workload] || 2);
    })
    .slice(0, count);

  return eligible.map((doctor, index) => ({
    doctorId: doctor.id,
    name: doctor.name,
    specialty: doctor.specialty,
    role: candidateRoles[index % candidateRoles.length].role,
    workload: doctor.workload,
  }));
}

/**
 * Deployment rule for nurses: only ON DUTY + Available nurses can be
 * recommended, and the configured workload constraint
 * (NURSE_WORKLOAD_LIMIT patients per nurse) must never be exceeded.
 */
export function selectNursesForSurge(nurses, count = 7) {
  const eligible = nurses
    .filter(isAvailable)
    .filter((nurse) => nurse.assignedPatients + 1 <= NURSE_WORKLOAD_LIMIT)
    .sort((a, b) => {
      const deptPriority = { ICU: 0, Emergency: 1, 'General Ward': 2, 'OT Complex': 3 };
      const priorityA = deptPriority[a.department] ?? 4;
      const priorityB = deptPriority[b.department] ?? 4;
      if (priorityA !== priorityB) return priorityA - priorityB;
      return a.assignedPatients - b.assignedPatients;
    })
    .slice(0, count);

  return eligible.map((nurse, index) => ({
    nurseId: nurse.id,
    name: nurse.name,
    department: nurse.department,
    assignment:
      index < 4
        ? 'Critical-care step-down / ICU escalation cover'
        : 'Emergency monitored bay cover',
    patientLoadAfter: nurse.assignedPatients + 1,
    workloadLimit: NURSE_WORKLOAD_LIMIT,
  }));
}

/* ------------------------------------------------------------------ *
 * Recommendation generation
 * ------------------------------------------------------------------ */

function buildRecommendations(state, metrics) {
  const demand = metrics.queue;
  const recommendations = [];
  const wards = metrics.beds.wards;
  const icuWard = wards.find((ward) => ward.id === 'icu');
  const emergencyWard = wards.find((ward) => ward.id === 'emergency');
  const generalWard = wards.find((ward) => ward.id === 'general');
  const ventilators = metrics.equipment.ventilators;
  const monitors = metrics.equipment.monitors;

  /* --- 1. General beds ------------------------------------------------
   * Eight general beds unlock two things at once: direct admission of the
   * general-bed queue and step-down of stable monitored emergency patients,
   * which releases emergency bays for the incoming surge.            */
  const generalTarget = 8;
  const generalFeasible = generalWard.available + generalWard.reserved >= generalTarget;
  recommendations.push({
    id: 'REC-BED-01',
    resource: 'Beds',
    title: 'General Beds → +8',
    highlight: '+8',
    summary:
      'Clear and hold 8 general beds to absorb direct admissions and step-down transfers from monitored emergency bays.',
    rationale: [
      `${demand.generalBedRequests} patients are waiting on a general bed and ${generalWard.available + generalWard.reserved} general beds are free or provisionally held.`,
      'Releasing monitored emergency bays through step-down directly reduces the emergency-bed shortfall created by the surge.',
    ],
    linkage: 'Releases 3 monitored emergency bays for incoming critical arrivals.',
    feasible: generalFeasible,
    feasibilityNote: generalFeasible
      ? 'Within current ward capacity — housekeeping clearance required for 8 beds.'
      : 'Not feasible without discharging or transferring inpatients (requires clinical governance).',
    requiresApproval: true,
    effect: { type: 'HOLD_BEDS', payload: { wardId: 'general', count: generalTarget, reason: 'Surge admission and step-down pool' } },
  });

  /* --- 2. ICU capacity: two operational options ---------------------- */
  const icuEscalationBedIds = ESCALATION_BEDS.map((bed) => bed.id);
  recommendations.push({
    id: 'REC-ICU-01',
    resource: 'ICU',
    title: 'ICU Capacity → Review 2 options',
    highlight: '2 options',
    summary: `${demand.icuRequests} ICU-level requests against ${icuWard.available} vacant ICU bed. Two operational options are available for review.`,
    rationale: [
      `ICU demand is ${demand.icuRequests} beds; ${icuWard.available} bed is vacant and already committed to the highest-acuity case.`,
      'Both options are operational escalation routes — neither changes a clinical treatment decision.',
    ],
    linkage: 'ICU pressure also drives ventilator, nursing and theatre demand.',
    feasible: true,
    feasibilityNote: 'Option A is recommended: it adds capacity without moving any patient.',
    requiresApproval: true,
    options: [
      {
        id: 'icu-option-a',
        label: 'Option A — Activate 2 critical-care step-down bays',
        detail:
          'Bring HD-01 and HD-02 online as ICU-governed step-down bays with cardiac monitoring, ventilator-capable outlets and dedicated nursing cover.',
        addedCapacity: 2,
        tradeoff: 'Requires 2 ventilators and 4 nurses from the surge pool.',
        feasible: true,
        recommended: true,
        consequences: ['ICU capacity 10 → 12', 'Nursing requirement +4', 'Ventilator allocation reviewed'],
        effect: {
          type: 'ESCALATE_ICU',
          payload: {
            bedIds: icuEscalationBedIds,
            reason: 'Critical-care step-down bays activated under ICU governance',
          },
        },
      },
      {
        id: 'icu-option-b',
        label: 'Option B — Request escalation / transfer review',
        detail:
          'Raise a transfer-review request for the most clinically stable ICU patient with the partner tertiary facility. No patient is moved by MediCore.',
        addedCapacity: 0,
        tradeoff: 'Capacity only becomes available after clinical clearance and ambulance availability are confirmed.',
        feasible: true,
        recommended: false,
        pendingClinicalClearance: true,
        consequences: ['Transfer pathway review opened', 'Capacity contingent on clinical clearance'],
        effect: {
          type: 'OPEN_TRANSFER_REVIEW',
          payload: {
            reason: 'Transfer-review request raised for the most stable ICU patient',
            caseRef: 'IP-2211 A. Fernandes',
          },
        },
      },
    ],
    effect: null,
  });

  /* --- 3. Doctors ---------------------------------------------------- */
  const doctorAssignments = selectDoctorsForSurge(state.doctors, demand, 3);
  recommendations.push({
    id: 'REC-DOC-01',
    resource: 'Doctors',
    title: `Doctors → +${doctorAssignments.length}`,
    highlight: `+${doctorAssignments.length}`,
    summary: `${doctorAssignments.length} on-duty, available doctors can be redeployed to surge posts without breaching shift rules.`,
    rationale: [
      `Eligibility rule applied: specialty matches requirement, on duty, inside shift window, available (${metrics.doctors.available} doctors qualify).`,
      doctorAssignments.length
        ? `Least-loaded suitable doctors selected: ${doctorAssignments.map((entry) => entry.name).join(', ')}.`
        : 'No doctors currently satisfy the eligibility rule — specialist reinforcement must be requested.',
    ],
    linkage: 'Doctor coverage supports the emergency-bed and ICU escalation above.',
    feasible: doctorAssignments.length > 0,
    feasibilityNote: 'Off-duty and unavailable doctors are excluded from the recommendation.',
    requiresApproval: true,
    detail: doctorAssignments,
    effect: { type: 'ASSIGN_DOCTORS', payload: { assignments: doctorAssignments } },
  });

  /* --- 4. Nurses ----------------------------------------------------- */
  const nurseAssignments = selectNursesForSurge(state.nurses, 7);
  recommendations.push({
    id: 'REC-NUR-01',
    resource: 'Nurses',
    title: `Nurses → +${nurseAssignments.length}`,
    highlight: `+${nurseAssignments.length}`,
    summary: `${nurseAssignments.length} available nurses can be reassigned while staying inside the ${NURSE_WORKLOAD_LIMIT}-patient workload constraint.`,
    rationale: [
      `ICU nursing workload has reached the high band; ${metrics.nurses.atConstraint} nurses are already at the configured constraint.`,
      'Selection prioritises ICU and emergency experience, then lowest current patient load.',
    ],
    linkage: 'Required for the ICU step-down bays and emergency monitored-bay cover.',
    feasible: nurseAssignments.length > 0,
    feasibilityNote: `Workload constraint of ${NURSE_WORKLOAD_LIMIT} patients per nurse is enforced for every assignment.`,
    requiresApproval: true,
    detail: nurseAssignments,
    effect: { type: 'ASSIGN_NURSES', payload: { assignments: nurseAssignments } },
  });

  /* --- 5. Equipment -------------------------------------------------- */
  const freeVentilators = ventilators
    ? ventilators.units.filter((unit) => !unit.inUse && !unit.reserved).map((unit) => unit.id)
    : [];
  const ventilatorTarget = Math.min(2, freeVentilators.length);
  const monitorShortfall = Math.max(0, 6 - (monitors ? monitors.total - monitors.inUse : 0));
  recommendations.push({
    id: 'REC-EQP-01',
    resource: 'Equipment',
    title: `Ventilators → Reserve ${ventilatorTarget}`,
    highlight: `Reserve ${ventilatorTarget}`,
    summary: `${ventilatorTarget} free ventilators are held for the ventilation-required critical cases; monitor shortfall of ${monitorShortfall} units is flagged.`,
    rationale: [
      `${ventilators ? ventilators.inUse : 0} of ${ventilators ? ventilators.total : 0} ventilators are in use with ${freeVentilators.length} uncommitted units.`,
      `${demand.ventilatorRequests} queued patients require ventilator support.`,
      monitorShortfall > 0
        ? `Monitored-bay demand exceeds free monitors by ${monitorShortfall} units — reallocate from elective outpatient areas.`
        : 'Monitor availability covers the monitored-bay demand.',
    ],
    linkage: 'Ventilator holds are only useful once ICU or resuscitation capacity is confirmed.',
    feasible: ventilatorTarget > 0,
    feasibilityNote: 'Reserve capacity is finite — no uncommitted ventilators remain beyond this hold.',
    requiresApproval: true,
    detail: { unitIds: freeVentilators.slice(0, ventilatorTarget), monitorShortfall },
    effect: {
      type: 'RESERVE_EQUIPMENT',
      payload: {
        categoryId: 'ventilators',
        unitIds: freeVentilators.slice(0, ventilatorTarget),
        monitorShortfall,
        reason: 'Held for ventilation-required critical surge cases',
      },
    },
  });

  /* --- 6. OT --------------------------------------------------------- */
  const freeOt = metrics.ot.rooms.filter((room) => room.status === 'Available');
  const otDemand = state.otBacklog.length ? state.otBacklog : OT_BACKLOG;
  recommendations.push({
    id: 'REC-OT-01',
    resource: 'OT',
    title: `OT → Hold ${freeOt.length} theatre${freeOt.length === 1 ? '' : 's'}`,
    highlight: `Hold ${freeOt.length}`,
    summary: freeOt.length
      ? `${freeOt[0].id} is held for the emergency surgical case at ${freeOt[0].nextAvailableSlot || 'the next free slot'}. No scheduled procedure is cancelled automatically.`
      : 'No theatre is free — escalate the theatre schedule review with the OT coordinator.',
    rationale: [
      `${metrics.ot.active} of ${metrics.ot.total} theatres are active and ${metrics.ot.maintenance} is under maintenance.`,
      `${otDemand.length} surgical requests are outstanding, including an emergency damage-control case.`,
      'Elective deferral is an option offered to the OT coordinator, not an automatic action.',
    ],
    linkage: 'A theatre hold is worthless without anaesthesia, nursing and equipment cover.',
    feasible: freeOt.length > 0,
    feasibilityNote: 'OT-04 remains in maintenance until 04:00 PM; conversion is a coordinator decision.',
    requiresApproval: true,
    detail: {
      roomId: freeOt[0]?.id || 'OT-03',
      slot: freeOt[0]?.nextAvailableSlot || 'Next free slot',
      patientId: CONFLICT_CASE_ID,
      electiveOption: {
        roomId: 'OT-02',
        procedure: 'Orthopaedic — femoral fixation',
        offer: 'Offer elective deferral to 04:00 PM',
      },
    },
    effect: {
      type: 'HOLD_OT',
      payload: {
        roomId: freeOt[0]?.id || 'OT-03',
        patientId: CONFLICT_CASE_ID,
        slot: freeOt[0]?.nextAvailableSlot || 'Next free slot',
        electiveRoomId: 'OT-02',
      },
    },
  });

  /* --- 7. Emergency coverage ----------------------------------------- */
  recommendations.push({
    id: 'REC-EMG-01',
    resource: 'Emergency Coverage',
    title: 'Emergency Coverage → Increase',
    highlight: 'Increase',
    summary: `Open ${SURGE_OVERFLOW_BEDS.length} overflow monitored bays, a secondary resuscitation point and additional pre-hospital cover.`,
    rationale: [
      `${demand.emergencyBedRequests} emergency-bed requests against ${emergencyWard.available} vacant bays.`,
      'Resuscitation capacity is fully committed once the cardiac emergency is placed.',
      'Ambulance and trauma-kit cover must rise with intake volume to protect turnaround times.',
    ],
    linkage: 'Overflow bays still require the nursing cover recommended above.',
    feasible: true,
    feasibilityNote: 'Overflow bays are staffed from the surge nursing pool — capacity cannot be opened without them.',
    requiresApproval: true,
    detail: {
      overflowBays: SURGE_OVERFLOW_BEDS.length,
      secondaryResus: 1,
      ambulances: 1,
      specialistSlots: 2,
      traumaKits: 4,
    },
    effect: {
      type: 'EMERGENCY_COVERAGE',
      payload: {
        bedIds: SURGE_OVERFLOW_BEDS,
        secondaryResus: 1,
        ambulances: 1,
        specialistSlots: 2,
        traumaKits: 4,
      },
    },
  });

  return recommendations;
}

/* ------------------------------------------------------------------ *
 * Multi-resource conflict detection
 * ------------------------------------------------------------------ */

export function detectConflicts(state, metrics) {
  const demand = metrics.queue;
  const conflicts = [];
  const icuWard = metrics.beds.wards.find((ward) => ward.id === 'icu');
  const emergencyWard = metrics.beds.wards.find((ward) => ward.id === 'emergency');
  const ventilators = metrics.equipment.ventilators;
  const freeVentilators = ventilators ? ventilators.total - ventilators.inUse : 0;
  const freeOtRooms = metrics.ot.rooms.filter((room) => room.status === 'Available').length;

  /* Multi-resource case conflict (ICU + OT + specialist + nursing + ventilator) */
  const conflictCase = state.queue.find((entry) => entry.id === CONFLICT_CASE_ID);
  if (conflictCase) {
    const anaesthetists = state.doctors.filter((doctor) => doctor.specialty === 'Anaesthesiology');
    const anaesthetistAvailable = anaesthetists.some(isAvailable);
    const resourceRows = [
      { resource: 'ICU bed', value: `${icuWard.available} vacant (committed to higher-acuity case P009)`, status: 'Critical' },
      { resource: 'Operating theatre', value: `${freeOtRooms} free · OT-04 in maintenance`, status: 'Critical' },
      {
        resource: 'Specialist (Anaesthesiology)',
        value: anaesthetistAvailable ? 'Available' : 'Busy — in OT-01 procedure',
        status: anaesthetistAvailable ? 'Success' : 'Critical',
      },
      {
        resource: 'Nursing support',
        value: `${metrics.nurses.available} available · ICU band at constraint`,
        status: metrics.nurses.atConstraint > 0 ? 'Critical' : 'Success',
      },
      {
        resource: 'Ventilator',
        value: `${freeVentilators} free · ${demand.ventilatorRequests} cases require ventilation`,
        status: freeVentilators >= 2 ? 'Success' : 'Critical',
      },
    ];
    conflicts.push({
      id: 'CFL-01',
      severity: 'Critical',
      title: 'RESOURCE CONFLICT',
      caseId: conflictCase.id,
      caseLabel: `${conflictCase.id} · ${conflictCase.age}y ${conflictCase.sex} · ${conflictCase.priority}`,
      requirement: 'ICU · OT · Specialist · Nursing support · Ventilator',
      summary: 'Multi-resource capacity conflict detected.',
      detectedAt: new Date(),
      resources: resourceRows,
      blockedResources: resourceRows.filter((row) => row.status === 'Critical').map((row) => row.resource),
      actions: [
        'Review OT schedule',
        'Check ICU capacity',
        'Check specialist duty roster',
        'Check equipment availability',
        'Review escalation/transfer pathway',
      ],
      principleNote:
        'MediCore does not cancel another patient’s treatment or move patients automatically. These are review actions for the coordinating team.',
      linkedRecommendations: ['REC-ICU-01', 'REC-OT-01', 'REC-NUR-01', 'REC-EQP-01'],
      status: 'Open',
    });
  }

  /* Capacity gap conflicts */
  const capacityConflicts = [
    {
      id: 'CFL-02',
      resource: 'ICU Capacity',
      demand: demand.icuRequests,
      capacity: icuWard.available,
      unit: 'ICU beds',
      detail: 'ICU requests exceed vacant ICU beds. Escalation or transfer review required.',
    },
    {
      id: 'CFL-03',
      resource: 'Emergency Beds',
      demand: demand.emergencyBedRequests,
      capacity: emergencyWard.available,
      unit: 'emergency bays',
      detail: 'Monitored emergency bay demand exceeds vacant bays. Overflow capacity or step-down transfers required.',
    },
    {
      id: 'CFL-04',
      resource: 'OT Capacity',
      demand: Math.max(state.otBacklog.length, 1),
      capacity: freeOtRooms,
      unit: 'theatres',
      detail: 'Surgical requests exceed free theatres. Schedule review or elective deferral required.',
    },
  ];

  capacityConflicts.forEach((entry) => {
    if (entry.demand <= entry.capacity) return;
    const gap = entry.demand - entry.capacity;
    conflicts.push({
      id: entry.id,
      severity: gap >= 3 ? 'Critical' : 'Operational',
      title: `${entry.resource} shortfall`,
      summary: `${gap} ${entry.unit} short — ${entry.demand} required against ${entry.capacity} free.`,
      detail: entry.detail,
      demand: entry.demand,
      capacity: entry.capacity,
      gap,
      detectedAt: new Date(),
      actions: [
        entry.resource === 'ICU Capacity' ? 'Check ICU capacity and escalation bays' : null,
        entry.resource === 'Emergency Beds' ? 'Review step-down transfers to general ward' : null,
        entry.resource === 'OT Capacity' ? 'Review OT schedule with theatre coordinator' : null,
        'Review escalation/transfer pathway',
      ].filter(Boolean),
      linkedRecommendations:
        entry.resource === 'ICU Capacity'
          ? ['REC-ICU-01', 'REC-NUR-01']
          : entry.resource === 'Emergency Beds'
            ? ['REC-BED-01', 'REC-EMG-01']
            : ['REC-OT-01'],
      status: 'Open',
    });
  });

  /* Staffing conflicts */
  if (metrics.nurses.atConstraint > 0 || metrics.nurses.workloadIndex >= 75) {
    conflicts.push({
      id: 'CFL-05',
      severity: 'Operational',
      title: 'Nursing workload constraint',
      summary: `${metrics.nurses.atConstraint} nurses are at the ${NURSE_WORKLOAD_LIMIT}-patient workload limit; ICU workload band is high.`,
      detail: 'Assignment beyond the configured constraint requires coordinator approval and is flagged as out of policy.',
      detectedAt: new Date(),
      actions: ['Check nursing roster', 'Reassign available nurses', 'Request off-shift reinforcement'],
      linkedRecommendations: ['REC-NUR-01'],
      status: 'Open',
    });
  }

  return conflicts;
}

/* ------------------------------------------------------------------ *
 * Projection — apply recommendation effects to a draft state
 * ------------------------------------------------------------------ */

const makeBedUnit = (bed, wardId, wardName, bedType, note, features) => ({
  id: bed,
  wardId,
  ward: wardName,
  bedType,
  status: BED_STATUS.AVAILABLE,
  patient: null,
  features,
  heldFor: note,
  escalation: true,
});

/**
 * Pure function: returns a new hospital state with the given recommendations
 * applied. Used both for the projection panel and for the real confirmation, so
 * a confirmed allocation always matches what was projected.
 */
export function applyRecommendations(state, recommendations, selections = {}, options = {}) {
  let draft = {
    ...state,
    bedUnits: state.bedUnits.map((unit) => ({ ...unit })),
    doctors: state.doctors.map((doctor) => ({ ...doctor })),
    nurses: state.nurses.map((nurse) => ({ ...nurse })),
    equipment: state.equipment.map((category) => ({ ...category, units: category.units.map((unit) => ({ ...unit })) })),
    emergencyResources: state.emergencyResources.map((resource) => ({ ...resource })),
    otRooms: state.otRooms.map((room) => ({ ...room })),
    escalation: { ...(state.escalation || {}) },
  };

  const applied = [];

  recommendations.forEach((recommendation) => {
    if (recommendation.effect) {
      const result = applyEffect(draft, recommendation.effect, recommendation);
      draft = result.state;
      applied.push({ id: recommendation.id, note: result.note });
      return;
    }

    if (recommendation.options) {
      const chosenId = selections[recommendation.id] || recommendation.options.find((option) => option.recommended)?.id;
      const chosen = recommendation.options.find((option) => option.id === chosenId) || recommendation.options[0];
      const result = applyEffect(draft, chosen.effect, recommendation);
      draft = result.state;
      applied.push({ id: recommendation.id, optionId: chosen.id, note: `${chosen.label} — ${result.note}` });
    }
  });

  // Reserve one spare ventilator unit whenever ICU capacity is escalated,
  // which keeps equipment and capacity decisions linked.
  const icuEscalated = applied.some((entry) => entry.id === 'REC-ICU-01' && entry.optionId === 'icu-option-a');
  if (icuEscalated) {
    const ventilators = draft.equipment.find((category) => category.id === 'ventilators');
    if (ventilators) {
      const spare = ventilators.units.find((unit) => !unit.inUse && !unit.reserved);
      if (spare) {
        spare.reserved = true;
        spare.status = 'Reserved';
        spare.reservedFor = 'ICU step-down bay (HD-01)';
        ventilators.reserved = ventilators.units.filter((unit) => unit.reserved).length;
        applied.push({ id: 'REC-EQP-01-link', note: `Ventilator ${spare.id} committed to step-down bay HD-01` });
      }
    }
  }

  if (options.withAllocation !== false) {
    const { allocations, remainingQueue, updatedBedUnits } = planAllocations(draft);
    draft = {
      ...draft,
      bedUnits: updatedBedUnits,
      queue: remainingQueue,
      allocations: [...(state.allocations || []), ...allocations],
    };
  }

  const metrics = calculateHospitalMetrics(draft);
  draft.conflicts = options.withConflicts === false ? draft.conflicts : markConflicts(draft, metrics);
  draft.appliedActions = applied;

  return { state: draft, applied, metrics };
}

function applyEffect(draft, effect, recommendation) {
  switch (effect.type) {
    case 'HOLD_BEDS': {
      let remaining = effect.payload.count;
      draft.bedUnits = draft.bedUnits.map((unit) => {
        if (
          remaining > 0 &&
          unit.wardId === effect.payload.wardId &&
          unit.status === BED_STATUS.AVAILABLE &&
          !unit.heldByRecommendation
        ) {
          remaining -= 1;
          return {
            ...unit,
            status: BED_STATUS.RESERVED,
            heldFor: `${effect.payload.reason} (${recommendation.id})`,
            heldByRecommendation: recommendation.id,
          };
        }
        return unit;
      });
      return {
        state: draft,
        note: `${effect.payload.count - remaining} of ${effect.payload.count} beds held for the surge admission pool`,
      };
    }

    case 'ESCALATE_ICU': {
      const newUnits = effect.payload.bedIds.map((bedId, index) =>
        makeBedUnit(
          bedId,
          'icu',
          'Intensive Care Unit',
          'ICU Bed',
          effect.payload.reason,
          index === 0
            ? ['Ventilator', 'Central monitor', 'Step-down bay']
            : ['Ventilator', 'Central monitor', 'Step-down bay'],
        ),
      );
      draft.bedUnits = [...draft.bedUnits, ...newUnits];
      draft.escalation = {
        ...draft.escalation,
        icuStepDownBays: (draft.escalation?.icuStepDownBays || 0) + newUnits.length,
      };
      return { state: draft, note: `${newUnits.length} critical-care step-down bays activated as ICU-governed capacity` };
    }

    case 'OPEN_TRANSFER_REVIEW': {
      draft.escalation = {
        ...draft.escalation,
        transferReviews: [
          ...(draft.escalation?.transferReviews || []),
          {
            id: 'TRF-01',
            caseRef: effect.payload.caseRef,
            reason: effect.payload.reason,
            status: 'Awaiting clinical clearance',
            openedAt: new Date().toISOString(),
          },
        ],
      };
      return { state: draft, note: `Transfer-review request opened for ${effect.payload.caseRef} (no patient moved)` };
    }

    case 'ASSIGN_DOCTORS': {
      const ids = effect.payload.assignments.map((entry) => entry.doctorId);
      draft.doctors = draft.doctors.map((doctor) => {
        const assignment = effect.payload.assignments.find((entry) => entry.doctorId === doctor.id);
        if (!assignment) return doctor;
        return {
          ...doctor,
          availability: 'Busy',
          assignedToSurge: true,
          currentAssignment: `Surge response — ${assignment.role}`,
          deployment: 'Confirmed by coordinator',
        };
      });
      return { state: draft, note: `${ids.length} doctors deployed to surge response posts` };
    }

    case 'ASSIGN_NURSES': {
      draft.nurses = draft.nurses.map((nurse) => {
        const assignment = effect.payload.assignments.find((entry) => entry.nurseId === nurse.id);
        if (!assignment) return nurse;
        const patients = Math.min(
          assignment.patientLoadAfter,
          assignment.workloadLimit,
        );
        return {
          ...nurse,
          availability: 'Assigned',
          assignedToSurge: true,
          assignedPatients: patients,
          workload: patients >= 5 ? 'High' : patients >= 3 ? 'Moderate' : 'Low',
          currentAssignment: assignment.assignment,
          deployment: 'Confirmed by coordinator',
        };
      });
      return { state: draft, note: `${effect.payload.assignments.length} nurses reassigned within the workload constraint` };
    }

    case 'RESERVE_EQUIPMENT': {
      const category = draft.equipment.find((entry) => entry.id === effect.payload.categoryId);
      if (!category) return { state: draft, note: 'Equipment category unavailable' };
      category.units = category.units.map((unit) => {
        if (!effect.payload.unitIds.includes(unit.id)) return unit;
        return {
          ...unit,
          reserved: true,
          status: 'Reserved',
          reservedFor: 'Ventilation-required critical surge cases (P026 / P027)',
        };
      });
      category.reserved = category.units.filter((unit) => unit.reserved).length;
      return {
        state: draft,
        note: `${effect.payload.unitIds.join(', ')} reserved${effect.payload.monitorShortfall > 0 ? ` · monitor shortfall ${effect.payload.monitorShortfall} flagged` : ''}`,
      };
    }

    case 'HOLD_OT': {
      const room = draft.otRooms.find((entry) => entry.id === effect.payload.roomId);
      if (!room) return { state: draft, note: 'No theatre available to hold' };
      room.status = 'Held';
      room.heldFor = `Held for emergency surgical case ${effect.payload.patientId} — slot ${effect.payload.slot}`;
      room.patientId = effect.payload.patientId;
      draft.otRooms = draft.otRooms.map((entry) => (entry.id === room.id ? room : entry));
      draft.otBacklog = (draft.otBacklog || []).map((entry) =>
        entry.patientId === effect.payload.patientId
          ? { ...entry, status: 'Theatre held — awaiting surgical team' }
          : entry,
      );
      draft.escalation = {
        ...draft.escalation,
        electiveDeferralOffered: {
          roomId: effect.payload.electiveRoomId,
          offer: 'Elective deferral to 04:00 PM offered to the theatre coordinator',
        },
      };
      return { state: draft, note: `${room.id} held for ${effect.payload.patientId} at ${effect.payload.slot}` };
    }

    case 'EMERGENCY_COVERAGE': {
      const newUnits = effect.payload.bedIds.map((bedId) =>
        makeBedUnit(
          bedId,
          'emergency',
          'Emergency Ward',
          'Emergency Bed',
          'Surge overflow monitored bay',
          ['Oxygen outlet', 'Monitored bay', 'Overflow area'],
        ),
      );
      draft.bedUnits = [...draft.bedUnits, ...newUnits];
      draft.emergencyResources = draft.emergencyResources.map((resource) => {
        if (resource.id === 'resus') {
          return { ...resource, total: resource.total + effect.payload.secondaryResus, secondaryPointOpened: true };
        }
        if (resource.id === 'trauma-kits') {
          return { ...resource, total: resource.total + effect.payload.traumaKits };
        }
        if (resource.id === 'emergency-specialists') {
          return { ...resource, total: resource.total + effect.payload.specialistSlots };
        }
        if (resource.id === 'ambulances') {
          return { ...resource, heldFor: `${effect.payload.ambulances} additional ambulance on standby` };
        }
        return resource;
      });
      draft.escalation = {
        ...draft.escalation,
        emergencyOverflowBays: (draft.escalation?.emergencyOverflowBays || 0) + newUnits.length,
        secondaryResusPoint: true,
      };
      return {
        state: draft,
        note: `${newUnits.length} overflow monitored bays, secondary resuscitation point and additional pre-hospital cover activated`,
      };
    }

    default:
      return { state: draft, note: 'No operational change' };
  }
}

/* ------------------------------------------------------------------ *
 * Allocation planning — which patients can be placed right now
 * ------------------------------------------------------------------ */

/**
 * Walks the ranked queue and matches each patient to a resource that is
 * genuinely available in the draft state. A patient is only marked "allocated"
 * when every requested resource is secured; otherwise the patient stays in the
 * queue with a partially-secured flag so nothing is silently resolved.
 */
export function planAllocations(draft) {
  const pools = {
    'General Bed': draft.bedUnits.filter(
      (unit) => unit.bedType === 'General Bed' && unit.wardId !== 'maternity' && unit.status !== BED_STATUS.OCCUPIED,
    ),
    'Emergency Bed': draft.bedUnits.filter(
      (unit) => unit.wardId === 'emergency' && unit.status !== BED_STATUS.OCCUPIED,
    ),
    'ICU Bed': draft.bedUnits.filter((unit) => unit.wardId === 'icu' && unit.status !== BED_STATUS.OCCUPIED),
  };

  const ventilators = draft.equipment.find((category) => category.id === 'ventilators');
  const ventPool = ventilators ? ventilators.units.filter((unit) => !unit.inUse && !unit.reserved) : [];
  const resus = draft.emergencyResources.find((resource) => resource.id === 'resus');
  const resusPool = resus ? [{ id: `RESUS-0${resus.inUse + 1}`, heldFor: resus.heldFor }] : [];

  const usedBedIds = new Set();
  const allocations = [];
  const remainingQueue = [];

  const takeBed = (poolKey, patientId) => {
    const pool = pools[poolKey] || [];
    // Provisional holds created for the surge are honoured for their planned case.
    const held = pool.find((unit) => !usedBedIds.has(unit.id) && unit.heldFor && unit.heldFor.includes(patientId));
    const fallback = pool.find((unit) => !usedBedIds.has(unit.id));
    const chosen = held || fallback;
    if (chosen) usedBedIds.add(chosen.id);
    return chosen || null;
  };

  const takeVentilator = (patientId) => {
    const held = ventPool.find((unit) => !unit.allocationUsed && unit.reservedFor && unit.reservedFor.includes(patientId));
    const fallback = ventPool.find((unit) => !unit.allocationUsed);
    const chosen = held || fallback;
    if (chosen) chosen.allocationUsed = true;
    return chosen || null;
  };

  rankQueue(draft.queue).forEach((entry) => {
    const secured = [];
    const pending = [];
    let bed = null;

    if (entry.requiredResource === 'Resuscitation Bay') {
      if (resusPool.length) {
        const bay = resusPool.shift();
        secured.push({ resource: 'Resuscitation Bay', ref: bay.id });
      } else {
        pending.push('Resuscitation Bay');
      }
    } else {
      bed = takeBed(entry.requiredResource, entry.id);
      if (bed) secured.push({ resource: entry.requiredResource, ref: bed.id });
      else pending.push(entry.requiredResource);
    }

    if (entry.requiresVentilator) {
      const vent = takeVentilator(entry.id);
      if (vent) secured.push({ resource: 'Ventilator', ref: vent.id });
      else pending.push('Ventilator');
    }

    if (entry.secondaryResource && entry.secondaryResource !== 'ICU Bed') {
      const secondaryRoom = draft.otRooms.find(
        (room) => room.status === 'Held' && room.patientId === entry.id,
      );
      if (secondaryRoom) secured.push({ resource: entry.secondaryResource, ref: secondaryRoom.id });
      else pending.push(entry.secondaryResource);
    }

    if (entry.secondaryResource === 'ICU Bed' && !bed) {
      const icuFallback = takeBed('ICU Bed', entry.id);
      if (icuFallback) secured.push({ resource: 'ICU Bed', ref: icuFallback.id });
      else pending.push('ICU Bed');
    }

    const fullySecured = pending.length === 0;
    if (!fullySecured && secured.length === 0) {
      remainingQueue.push(entry);
      return;
    }

    allocations.push({
      patientId: entry.id,
      priority: entry.priority,
      status: fullySecured ? 'Allocated' : 'Partially secured',
      secured,
      pending,
      confirmedAt: new Date().toISOString(),
      note: fullySecured
        ? 'All requested resources secured — clinical team informed.'
        : `Awaiting ${pending.join(', ')} — escalation continues.`,
    });

    if (!fullySecured) {
      remainingQueue.push({
        ...entry,
        status: 'Allocation Proposed',
        securedResources: secured,
        pendingResources: pending,
      });
    }
  });

  const updatedBedUnits = draft.bedUnits.map((unit) => {
    if (!usedBedIds.has(unit.id)) return unit;
    const allocation = allocations.find((entry) => entry.secured.some((item) => item.ref === unit.id));
    return {
      ...unit,
      status: BED_STATUS.OCCUPIED,
      patient: allocation ? `${allocation.patientId} (allocated)` : unit.patient,
      heldFor: null,
    };
  });

  return { allocations, remainingQueue, updatedBedUnits };
}

/** Refreshes conflict status after a confirmed allocation. */
function markConflicts(draft, metrics) {
  const previous = draft.conflicts || [];
  if (!previous.length) return previous;
  const openResourceConflicts = [];

  const icuUnmet = Math.max(
    0,
    metrics.queue.icuRequests - metrics.beds.icu.available - metrics.allocations.filter((entry) => entry.secured.some((item) => item.resource === 'ICU Bed')).length,
  );

  return previous.map((conflict) => {
    if (conflict.id === 'CFL-01') {
      const remainingBlocked = [
        icuUnmet > 0 ? `ICU bed (${icuUnmet} ICU-level cases still awaiting capacity)` : null,
        metrics.equipment.ventilators && metrics.equipment.ventilators.total - metrics.equipment.ventilators.inUse > 0
          ? null
          : 'Ventilator (all uncommitted units reserved)',
      ].filter(Boolean);
      return {
        ...conflict,
        status: remainingBlocked.length ? 'Mitigation in progress' : 'Mitigated',
        mitigation: draft.appliedActions || [],
        remainingBlocked,
      };
    }
    const resourceKeyById = {
      'CFL-02': 'icu',
      'CFL-03': 'emergency',
      'CFL-04': 'ot',
      'CFL-05': 'nurses',
    };
    const pressure = metrics.pressure.byId[resourceKeyById[conflict.id]];
    const gap = pressure ? Math.max(0, pressure.demand - pressure.capacity) : 0;
    if (gap > 0) openResourceConflicts.push(conflict.id);
    return {
      ...conflict,
      status: gap > 0 ? 'Mitigation in progress' : 'Mitigated',
      gap,
      mitigation: draft.appliedActions || [],
    };
  });
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

/**
 * Runs the full multi-resource optimisation analysis against the current
 * hospital state and returns recommendations, conflicts, projection and a
 * human-readable operational narrative.
 */
export function optimizeResources(state, options = {}) {
  const selections = options.selections || {};
  const metrics = calculateHospitalMetrics(state);
  const demand = metrics.queue || calculateDemandProfile(state.queue);

  const recommendations = buildRecommendations(state, metrics);
  const conflicts = detectConflicts(state, metrics);

  const projection = applyRecommendations(
    { ...state, conflicts },
    recommendations,
    selections,
    { withAllocation: true },
  );

  const current = buildSnapshot(state, 'Current state');
  const recommended = buildSnapshot({ ...projection.state, conflicts }, 'Recommended state');

  const impact = [
    { label: 'Emergency queue waiting', before: current.emergencyQueue, after: recommended.emergencyQueue, unit: 'patients' },
    { label: 'Critical cases awaiting placement', before: current.criticalQueue, after: recommended.criticalQueue, unit: 'patients' },
    { label: 'ICU occupancy', before: current.icuOccupancy, after: recommended.icuOccupancy, unit: '%' },
    { label: 'Available beds', before: current.availableBeds, after: recommended.availableBeds, unit: 'beds' },
    { label: 'Doctors available', before: current.doctorsAvailable, after: recommended.doctorsAvailable, unit: 'staff' },
    { label: 'Nurses available', before: current.nursesAvailable, after: recommended.nursesAvailable, unit: 'staff' },
    { label: 'Equipment utilisation', before: current.equipmentUtilisation, after: recommended.equipmentUtilisation, unit: '%' },
    { label: 'Overall resource pressure', before: current.pressure, after: recommended.pressure, unit: 'index' },
  ];

  const analysisRows = [
    {
      resource: 'Patient demand',
      demand: `${demand.total} queued (${demand.critical} critical, ${demand.high} high)`,
      capacity: '—',
      gap: demand.critical > 3 ? `${demand.critical - 3} critical cases beyond immediate placement capacity` : 'Within immediate placement capacity',
    },
    {
      resource: 'Beds',
      demand: `${demand.generalBedRequests} general · ${demand.emergencyBedRequests} emergency · ${demand.resusRequests} resuscitation`,
      capacity: `${metrics.beds.general.available} general · ${metrics.beds.emergency.available} emergency`,
      gap: `${Math.max(0, demand.emergencyBedRequests - metrics.beds.emergency.available)} emergency bays short`,
    },
    {
      resource: 'ICU',
      demand: `${demand.icuRequests} ICU-level requests`,
      capacity: `${metrics.beds.icu.available} vacant ICU bed`,
      gap: `${Math.max(0, demand.icuRequests - metrics.beds.icu.available)} ICU beds short`,
    },
    {
      resource: 'Doctors',
      demand: `${demand.total} patients · ${Object.keys(demand.specialistNeeds).length} specialties required`,
      capacity: `${metrics.doctors.onDuty} on duty · ${metrics.doctors.available} available`,
      gap: `${recommendations.find((entry) => entry.id === 'REC-DOC-01').detail.length} eligible doctors for redeployment`,
    },
    {
      resource: 'Nurses',
      demand: `${demand.total} patients · high-acuity band`,
      capacity: `${metrics.nurses.onDuty} on duty · ${metrics.nurses.available} available`,
      gap: `${metrics.nurses.atConstraint} at ${NURSE_WORKLOAD_LIMIT}-patient constraint`,
    },
    {
      resource: 'OT',
      demand: `${state.otBacklog.length || OT_BACKLOG.length} surgical requests`,
      capacity: `${metrics.ot.available} free theatre`,
      gap: `${Math.max(0, (state.otBacklog.length || OT_BACKLOG.length) - metrics.ot.available)} theatre short`,
    },
    {
      resource: 'Equipment',
      demand: `${demand.ventilatorRequests} ventilator requirements`,
      capacity: `${metrics.equipment.ventilators.available} available (${metrics.equipment.ventilators.reserved} reserved)`,
      gap: `${Math.max(0, demand.ventilatorRequests - metrics.equipment.ventilators.available)} ventilators at risk`,
    },
    {
      resource: 'Emergency resources',
      demand: `${demand.emergencyBedRequests + demand.resusRequests} monitored / resuscitation requests`,
      capacity: `${metrics.emergencyResources.find((entry) => entry.id === 'resus').available} resus bays · ${metrics.emergencyResources.find((entry) => entry.id === 'em-beds').available} emergency beds`,
      gap: 'Resuscitation capacity fully committed for critical arrivals',
    },
  ];

  const narrative = [
    `Demand profile: ${demand.total} patients queued (${demand.critical} critical, ${demand.high} high, ${demand.medium} medium, ${demand.low} low).`,
    `Capacity check: ${metrics.beds.available} of ${metrics.beds.total} beds free; ICU ${metrics.beds.icu.committed}/${metrics.beds.icu.units} committed.`,
    `Staffing check: ${metrics.doctors.available} doctors and ${metrics.nurses.available} nurses available within duty windows; ${metrics.nurses.atConstraint} nurses at the workload constraint.`,
    `Equipment check: ${metrics.equipment.utilisation}% aggregate utilisation; ${metrics.equipment.ventilators.available} ventilators available (${metrics.equipment.ventilators.reserved} reserved).`,
    `${conflicts.length} multi-resource conflict${conflicts.length === 1 ? '' : 's'} detected, including ${conflicts.filter((entry) => entry.severity === 'Critical').length} critical.`,
    `Recommendations generated across ${new Set(recommendations.map((entry) => entry.resource)).size} resource classes and cross-linked so that no single resource is optimised in isolation.`,
    'All recommendations are provisional and require authorised coordinator confirmation. Clinical treatment decisions are never automated.',
  ];

  return {
    id: `OPT-${Date.now()}`,
    generatedAt: new Date(),
    trigger: state.surge?.active ? 'surge' : 'baseline',
    recommendations,
    conflicts,
    analysisRows,
    narrative,
    current,
    recommended,
    impact,
    allocationPlan: projection.state.allocations.slice((state.allocations || []).length),
    projectedState: projection.state,
    projectedMetrics: projection.metrics,
    appliedActions: projection.applied,
    pressureBefore: calculateResourcePressure(state),
    pressureAfter: calculateResourcePressure({ ...projection.state, conflicts }),
  };
}

/** Approval record created alongside every optimisation run. */
export function buildApprovalRequest(optimization, requestedBy) {
  const summary = {};
  optimization.recommendations.forEach((recommendation) => {
    if (recommendation.id === 'REC-DOC-01') summary.doctors = recommendation.detail.length;
    if (recommendation.id === 'REC-NUR-01') summary.nurses = recommendation.detail.length;
    if (recommendation.id === 'REC-BED-01') summary.generalBeds = 8;
    if (recommendation.id === 'REC-EQP-01') summary.ventilators = recommendation.detail.unitIds.length;
    if (recommendation.id === 'REC-ICU-01') summary.icuOptions = recommendation.options.length;
    if (recommendation.id === 'REC-OT-01') summary.otTheatres = 1;
    if (recommendation.id === 'REC-EMG-01') summary.emergencyCoverage = 'Increase';
  });

  return {
    id: `APR-${String(Math.floor(optimization.generatedAt.getTime() / 1000) % 10000).padStart(4, '0')}`,
    title: 'Emergency Resource Reallocation',
    subtitle: 'Generated by the multi-resource optimisation engine',
    requestedBy,
    createdAt: new Date().toISOString(),
    status: 'Pending Review',
    priority: 'Critical',
    summary,
    recommendationIds: optimization.recommendations.map((entry) => entry.id),
    conflictsRaised: optimization.conflicts.length,
    impact: optimization.impact,
    optimizationId: optimization.id,
  };
}
