/**
 * Multi-resource optimization engine (§23–25, §27, §51).
 *
 * The engine reads the whole hospital state once and reasons about beds, ICU
 * capacity, doctors, nurses, equipment, emergency resources and theatres
 * *together* — the multi-resource case (ICU + OT + specialist + nursing +
 * ventilator) is treated as a single coordination problem.
 *
 * It never applies anything: it returns recommendations, conflicts and a
 * projected impact. A person reviews and confirms (§31, §52).
 */

const { calculateHospitalMetrics, calculateResourcePressure, buildSnapshot } = require('../services/metricsService');
const { detectConflicts, findMultiResourceCase } = require('./constraintEngine');
const {
  selectDoctorForCase,
  selectNursesForReinforcement,
  selectEquipmentUnits,
  selectTheatresForHold,
  rankQueue,
} = require('./scoringEngine');
const { NURSE_WORKLOAD_LIMIT } = require('../../seeds/constants');

const cloneState = (state) => ({
  ...state,
  bedUnits: state.bedUnits.map((unit) => ({ ...unit })),
  doctors: state.doctors.map((doctor) => ({ ...doctor })),
  nurses: state.nurses.map((nurse) => ({ ...nurse })),
  equipment: state.equipment.map((category) => ({ ...category, units: category.units.map((unit) => ({ ...unit })) })),
  emergencyResources: state.emergencyResources.map((resource) => ({ ...resource })),
  otRooms: state.otRooms.map((room) => ({ ...room })),
  queue: state.queue.map((entry) => ({ ...entry })),
  escalation: { ...(state.escalation || {}) },
});

/* ------------------------------------------------------------------ effects */

/** Applies one recommendation effect to a draft state (pure). */
function applyEffect(draft, effect, selection = null) {
  if (!effect) return draft;
  switch (effect.kind) {
    case 'BED_CLEAR': {
      let remaining = effect.count;
      draft.bedUnits = draft.bedUnits.map((unit) => {
        if (remaining > 0 && unit.wardId === effect.wardId && ['Reserved', 'Cleaning'].includes(unit.status) && !unit.patient) {
          remaining -= 1;
          return { ...unit, status: 'Available', heldFor: 'Cleared for surge admissions', availableFrom: null };
        }
        return unit;
      });
      return draft;
    }
    case 'ICU_ESCALATION': {
      const bays = effect.bayIds || [];
      draft.bedUnits = draft.bedUnits.map((unit) =>
        bays.includes(unit.id)
          ? {
              ...unit,
              wardId: 'icu',
              ward: 'Intensive Care Unit',
              bedType: 'ICU Step-down Bay (escalation)',
              escalation: true,
              notes: 'Escalation bay — ICU-governed step-down capacity activated by coordinator confirmation.',
              heldFor: 'ICU step-down capacity',
            }
          : unit,
      );
      draft.escalation = { ...draft.escalation, icuStepDownBays: (draft.escalation.icuStepDownBays || 0) + bays.length };
      return draft;
    }
    case 'TRANSFER_REVIEW': {
      draft.escalation = {
        ...draft.escalation,
        transferReviews: [...(draft.escalation.transferReviews || []), { requestedAt: new Date(), note: effect.note }],
      };
      return draft;
    }
    case 'DOCTOR_ASSIGN': {
      effect.assignments.forEach((assignment) => {
        draft.doctors = draft.doctors.map((doctor) =>
          doctor.id === assignment.doctorId
            ? { ...doctor, availability: 'Assigned', patients: doctor.patients + 1, currentAssignment: `Surge post — ${assignment.role}` }
            : doctor,
        );
        draft.queue = draft.queue.map((entry) =>
          entry.id === assignment.queueId
            ? { ...entry, assignedDoctor: assignment.doctorName, assignedDoctorId: assignment.doctorId }
            : entry,
        );
      });
      return draft;
    }
    case 'NURSE_DEPLOY': {
      effect.deployments.forEach((deployment) => {
        draft.nurses = draft.nurses.map((nurse) =>
          nurse.id === deployment.nurseId
            ? {
                ...nurse,
                availability: 'Assigned',
                assignedPatients: nurse.assignedPatients + 1,
                workload: nurse.assignedPatients + 1 >= NURSE_WORKLOAD_LIMIT ? 'High' : nurse.workload,
                currentAssignment: `Surge cover — ${deployment.department}`,
              }
            : nurse,
        );
      });
      return draft;
    }
    case 'EQUIPMENT_RESERVE': {
      draft.equipment = draft.equipment.map((category) => {
        if (category.id !== effect.equipmentId) return category;
        const units = category.units.map((unit) =>
          effect.unitIds.includes(unit.id)
            ? { ...unit, reserved: true, status: 'Reserved', reservedFor: effect.reservedFor || 'Reserved for surge demand' }
            : unit,
        );
        return { ...category, units, reserved: units.filter((unit) => unit.reserved).length };
      });
      return draft;
    }
    case 'OT_HOLD': {
      draft.otRooms = draft.otRooms.map((room) =>
        effect.theatreIds.includes(room.id)
          ? { ...room, status: 'Held', notes: 'Held for emergency surgical review — no scheduled procedure cancelled.' }
          : room,
      );
      return draft;
    }
    case 'EMERGENCY_REINFORCE': {
      draft.emergencyResources = draft.emergencyResources.map((resource) =>
        resource.id === effect.resourceId
          ? { ...resource, heldFor: effect.note, status: 'Available' }
          : resource,
      );
      return draft;
    }
    default:
      return draft;
  }
}

/** Applies a full recommendation set (with selections) to a fresh draft. */
function projectRecommendations(state, recommendations, selections = {}) {
  let draft = cloneState(state);
  recommendations.forEach((recommendation) => {
    if (recommendation.options && recommendation.options.length) {
      const chosenId = selections[recommendation.id] || (recommendation.options.find((option) => option.recommended) || recommendation.options[0]).id;
      const chosen = recommendation.options.find((option) => option.id === chosenId) || recommendation.options[0];
      draft = applyEffect(draft, chosen.effect, chosen);
      return;
    }
    draft = applyEffect(draft, recommendation.effect, recommendation);
  });
  return draft;
}

/* ------------------------------------------------------------------ placements */

/** How many queued patients the projected state can actually place. */
function projectPlacements(state, draft, queue) {
  const beds = draft.bedUnits.map((unit) => ({ ...unit }));
  const equipment = draft.equipment.map((category) => ({ ...category, units: category.units.map((unit) => ({ ...unit })) }));
  const theatres = draft.otRooms.map((room) => ({ ...room }));
  const placed = [];

  const takeBed = (wardId, resource) => {
    const wantedWard = resource === 'ICU Bed' ? 'icu' : resource === 'Emergency Bed' ? 'emergency' : 'general';
    const index = beds.findIndex((unit) => unit.wardId === wantedWard && unit.status === 'Available');
    if (wantedWard !== wardId && index === -1) return false;
    if (index === -1) return false;
    beds[index] = { ...beds[index], status: 'Reserved', heldFor: 'Projected placement' };
    return true;
  };

  const takeVentilator = () => {
    const category = equipment.find((entry) => entry.id === 'ventilators');
    if (!category) return true;
    const unit = category.units.find((entry) => !entry.inUse && !entry.reserved);
    if (!unit) return false;
    unit.reserved = true;
    unit.status = 'Reserved';
    unit.reservedFor = 'Projected ventilation support';
    category.reserved = category.units.filter((entry) => entry.reserved).length;
    return true;
  };

  const takeTheatre = () => {
    const index = theatres.findIndex((room) => room.status === 'Available' || room.status === 'Held');
    if (index === -1) return false;
    theatres[index] = { ...theatres[index], status: 'Held', heldFor: 'Projected emergency case' };
    return true;
  };

  rankQueue(queue).forEach((entry) => {
    let ok = true;
    if (entry.requiredResource) ok = takeBed(null, entry.requiredResource) && ok;
    if (ok && entry.requiresVentilator) ok = takeVentilator();
    if (ok && entry.needsOt) ok = takeTheatre();
    if (ok) placed.push(entry.id);
  });

  return placed;
}

/* ------------------------------------------------------------------ builder */

/**
 * Runs the multi-resource optimization for a state.
 * @returns {{ recommendations: Array, conflicts: Array, impact: Array, analysis: Object }}
 */
function optimizeResources(state, { selections = {} } = {}) {
  const metrics = calculateHospitalMetrics(state);
  const pressure = calculateResourcePressure(state);
  const conflicts = detectConflicts(state, metrics);
  const queue = rankQueue(state.queue);
  const multiResourceCase = findMultiResourceCase(state);
  const recommendations = [];

  const icuWard = metrics.beds.wards.find((ward) => ward.id === 'icu') || { available: 0, units: 0, committed: 0, reserved: 0 };
  const generalWard = metrics.beds.wards.find((ward) => ward.id === 'general') || { available: 0, reserved: 0, cleaning: 0 };
  const emergencyWard = metrics.beds.wards.find((ward) => ward.id === 'emergency') || { available: 0 };
  const ventilators = metrics.equipment.ventilators;
  const freeVentilators = ventilators ? ventilators.free : 0;
  const monitors = metrics.equipment.monitors;
  const freeOt = selectTheatresForHold(state, state.otRooms.length);

  /* ------------------------------------------- 1. general bed capacity */
  const generalCleared = state.bedUnits.filter(
    (unit) => unit.wardId === 'general' && ['Reserved', 'Cleaning'].includes(unit.status) && !unit.patient,
  ).length;
  const generalGap = Math.max(0, metrics.queue.generalBedRequests - generalWard.available);
  if (generalGap > 0 || generalCleared > 0) {
    const quantity = Math.max(generalGap, generalCleared);
    recommendations.push({
      id: 'REC-BED-01',
      resource: 'Beds',
      resourceCode: 'BED',
      action: 'ALLOCATE',
      title: `General Beds → +${quantity}`,
      highlight: `+${quantity}`,
      summary:
        'Clear and hold general beds to absorb direct admissions and step-down transfers from monitored emergency bays.',
      detail: [
        `${metrics.queue.generalBedRequests} queued patient(s) require a general bed; ${generalWard.available} bed(s) are currently free.`,
        `${generalCleared} general bed(s) are held or in cleaning turnaround and can be returned to service.`,
        'Discharge decisions stay with the treating team — this only releases operational capacity for review.',
      ],
      reason: `${generalGap} general-bed request(s) beyond current availability; ${generalCleared} held/turnaround bed(s) can be cleared.`,
      requiresApproval: true,
      quantity,
      effect: { kind: 'BED_CLEAR', wardId: 'general', count: quantity },
      score: { utilisation: generalWard.occupancyPercentage, unmet: generalGap },
    });
  }

  /* ------------------------------------------- 2. ICU capacity (options) */
  const escalationBays = state.bedUnits.filter(
    (unit) => unit.escalation && unit.wardId !== 'icu' && unit.status === 'Available',
  );
  const icuGap = Math.max(0, metrics.queue.icuRequests - icuWard.available);
  if (icuGap > 0 || icuWard.available <= 1) {
    recommendations.push({
      id: 'REC-ICU-01',
      resource: 'ICU',
      resourceCode: 'ICU_BED',
      action: 'REVIEW',
      title: 'ICU Capacity → Review escalation options',
      highlight: '2 options',
      summary:
        escalationBays.length > 0
          ? `${metrics.queue.icuRequests} ICU-level request(s) against ${icuWard.available} vacant ICU bed(s). ${escalationBays.length} monitored escalation bay(s) can be re-designated as ICU-governed step-down capacity — no patient is moved.`
          : `${metrics.queue.icuRequests} ICU-level request(s) against ${icuWard.available} vacant ICU bed(s). Escalation review required.`,
      detail: [
        `${icuWard.committed} of ${icuWard.units} ICU beds are committed; ${icuWard.reserved} held for incoming cases.`,
        escalationBays.length
          ? `${escalationBays.map((unit) => unit.id).join(', ')} are monitored bays flagged as escalation capacity.`
          : 'No escalation bays are currently free.',
        'Neither option changes a clinical treatment decision or moves an existing patient.',
      ],
      reason: `ICU demand exceeds vacancy by ${icuGap <= 0 ? 'a margin below the safety threshold' : `${icuGap} bed(s)`}; escalation capacity review required.`,
      requiresApproval: true,
      quantity: escalationBays.length,
      options: [
        {
          id: 'icu-option-a',
          label: escalationBays.length
            ? `${escalationBays.length} monitored step-down bay${escalationBays.length === 1 ? '' : 's'}`
            : 'Monitored step-down bays (none free)',
          detail: escalationBays.length
            ? `Re-designate ${escalationBays.map((unit) => unit.id).join(' and ')} as ICU-governed step-down capacity with cardiac monitoring. This is a capacity measure only — no patient is moved and no treatment decision changes.`
            : 'Both monitored escalation bays are occupied. Re-designation is only possible after a clinical step-down review frees one with the treating team.',
          addedCapacity: escalationBays.length,
          tradeoff: escalationBays.length
            ? 'Requires ventilator cover and nursing reinforcement from the surge pool.'
            : 'Adds no capacity until a bay is released by the treating team.',
          recommended: escalationBays.length > 0,
          effect: { kind: 'ICU_ESCALATION', bayIds: escalationBays.map((unit) => unit.id) },
        },
        {
          id: 'icu-option-b',
          label: 'Escalation / transfer review',
          detail: 'Open a transfer review for the most clinically stable ICU case with the treating team.',
          addedCapacity: 0,
          tradeoff: 'Capacity becomes available only after clinical clearance and transport confirmation.',
          recommended: escalationBays.length === 0,
          effect: {
            kind: 'TRANSFER_REVIEW',
            note: 'Transfer / escalation review opened — clinical clearance required.',
          },
        },
      ],
      score: { utilisation: icuWard.occupancyPercentage, unmet: icuGap },
    });
  }

  /* ------------------------------------------- 3. doctor coverage */
  const uncovered = queue.filter((entry) => !entry.assignedDoctor).slice(0, 6);
  const doctorAssignments = [];
  const usedDoctors = new Set();
  uncovered.forEach((entry) => {
    const selection = selectDoctorForCase(state, entry, { exclude: [...usedDoctors] });
    if (selection.doctorId) {
      usedDoctors.add(selection.doctorId);
      doctorAssignments.push({
        queueId: entry.id,
        doctorId: selection.doctorId,
        doctorName: selection.name,
        specialty: selection.specialty,
        role: `${entry.specialtyRequired} requirement`,
        reason: selection.reason,
      });
    }
  });
  const escalationNeeded = uncovered.length - doctorAssignments.length;

  if (doctorAssignments.length || escalationNeeded > 0) {
    recommendations.push({
      id: 'REC-DOC-01',
      resource: 'Doctors',
      resourceCode: 'DOCTOR',
      action: doctorAssignments.length ? 'ALLOCATE' : 'ESCALATE',
      title: `Doctors → ${doctorAssignments.length ? `+${doctorAssignments.length}` : 'Escalation required'}`,
      highlight: doctorAssignments.length ? `+${doctorAssignments.length}` : 'Escalation',
      summary: doctorAssignments.length
        ? `${doctorAssignments.length} on-duty, available doctor(s) can cover queued cases without breaching shift rules.`
        : 'No on-duty doctor matches the outstanding requirements — an escalation / call-in request is required.',
      detail: [
        `Eligibility rule applied: specialty match + ON_DUTY + available (${metrics.doctors.available} doctor(s) qualify).`,
        doctorAssignments.length
          ? `Least-loaded suitable doctors: ${doctorAssignments.map((entry) => `${entry.doctorName} → ${entry.queueId}`).join(', ')}.`
          : 'Off-duty doctors are never proposed automatically — authorized staff must raise a call-in request.',
        escalationNeeded > 0
          ? `${escalationNeeded} case(s) have no eligible on-duty doctor and need specialist escalation.`
          : 'Every uncovered case has an eligible doctor.',
      ],
      reason: `${uncovered.length} queued case(s) have no assigned doctor.`,
      requiresApproval: true,
      quantity: doctorAssignments.length,
      effect: { kind: 'DOCTOR_ASSIGN', assignments: doctorAssignments },
      score: { available: metrics.doctors.available, uncovered: uncovered.length },
    });
  }

  /* ------------------------------------------- 4. nursing reinforcement */
  const nurseNeed = Math.max(
    metrics.nurses.atConstraint,
    Math.ceil(metrics.queue.critical / 2),
    metrics.beds.icu.escalation || 0,
  );
  const nurseDeployments = selectNursesForReinforcement(
    state,
    ['ICU', 'Emergency', 'General Ward', 'OT Complex'],
    Math.min(nurseNeed, metrics.nurses.available),
  ).map((candidate) => ({
    nurseId: candidate.nurseId,
    nurseName: candidate.name,
    department: candidate.department,
    reason: candidate.reason,
  }));

  if (nurseDeployments.length || metrics.nurses.atConstraint > 0) {
    recommendations.push({
      id: 'REC-NUR-01',
      resource: 'Nurses',
      resourceCode: 'NURSE',
      action: 'REALLOCATE',
      title: `Nurses → +${nurseDeployments.length}`,
      highlight: `+${nurseDeployments.length}`,
      summary: `${nurseDeployments.length} available nurse(s) can be deployed while staying inside the ${NURSE_WORKLOAD_LIMIT}-patient workload constraint.`,
      detail: [
        `${metrics.nurses.atConstraint} nurse(s) are already at the configured ${NURSE_WORKLOAD_LIMIT}-patient constraint; ${metrics.nurses.available} are deployable.`,
        nurseDeployments.length
          ? `Selected by area fit then lowest patient load: ${nurseDeployments.map((entry) => `${entry.nurseName} (${entry.department})`).join(', ')}.`
          : 'No deployable nurse remains — off-shift reinforcement must be requested.',
        `The ${NURSE_WORKLOAD_LIMIT}-patient constraint is enforced for every deployment.`,
      ],
      reason: `${metrics.nurses.atConstraint} nurse(s) at the workload limit with ${metrics.queue.critical} critical patient(s) queued.`,
      requiresApproval: true,
      quantity: nurseDeployments.length,
      effect: { kind: 'NURSE_DEPLOY', deployments: nurseDeployments },
      score: { atConstraint: metrics.nurses.atConstraint, available: metrics.nurses.available },
    });
  }

  /* ------------------------------------------- 5. equipment (ventilators) */
  const ventilatorTarget = Math.min(freeVentilators, Math.max(metrics.queue.ventilatorRequests, 1));
  const monitorShortfall = Math.max(0, metrics.queue.emergencyBedRequests - (monitors ? monitors.free : 0));
  if (ventilatorTarget > 0 || monitorShortfall > 0) {
    const { units } = selectEquipmentUnits(state, 'ventilators', ventilatorTarget);
    recommendations.push({
      id: 'REC-EQP-01',
      resource: 'Equipment',
      resourceCode: 'EQUIPMENT',
      action: 'HOLD',
      title: `Ventilators → Reserve ${ventilatorTarget}`,
      highlight: `Reserve ${ventilatorTarget}`,
      summary: `${ventilatorTarget} uncommitted ventilator unit(s) held for the ventilation-required critical cases; monitor shortfall of ${monitorShortfall} unit(s) is flagged.`,
      detail: [
        `${ventilators ? ventilators.inUse : 0} of ${ventilators ? ventilators.total : 0} ventilators are in use with ${freeVentilators} uncommitted unit(s).`,
        `${metrics.queue.ventilatorRequests} queued patient(s) require ventilator support.`,
        monitorShortfall > 0
          ? `Monitored-bay demand exceeds free monitors by ${monitorShortfall} unit(s) — review monitor allocation with the coordinator.`
          : 'Monitor availability covers the monitored-bay demand.',
        units.length ? `Units proposed: ${units.map((unit) => unit.id).join(', ')}.` : 'No free unit is available — equipment escalation required.',
      ],
      reason: `${metrics.queue.ventilatorRequests} ventilation requirement(s) against ${freeVentilators} uncommitted ventilator(s).`,
      requiresApproval: true,
      quantity: units.length,
      effect: { kind: 'EQUIPMENT_RESERVE', equipmentId: 'ventilators', unitIds: units.map((unit) => unit.id), reservedFor: 'Held for queued critical cases requiring ventilation' },
      score: { free: freeVentilators, demand: metrics.queue.ventilatorRequests },
    });
  }

  /* ------------------------------------------- 6. theatre capacity */
  const otHold = freeOt.slice(0, Math.max(1, Math.min(freeOt.length, state.otBacklog.length)));
  if (otHold.length || state.otBacklog.length) {
    recommendations.push({
      id: 'REC-OT-01',
      resource: 'OT',
      resourceCode: 'OT',
      action: 'HOLD',
      title: `OT → Hold ${otHold.length} theatre${otHold.length === 1 ? '' : 's'}`,
      highlight: `Hold ${otHold.length}`,
      summary: otHold.length
        ? `${otHold[0].theatreId} is held for the emergency surgical case${otHold[0].nextAvailableSlot ? ` (free from ${otHold[0].nextAvailableSlot})` : ''}. No scheduled procedure is cancelled automatically.`
        : 'No theatre is free — the theatre schedule review must be escalated to the OT coordinator.',
      detail: [
        `${metrics.ot.active} of ${metrics.ot.total} theatres are active; ${metrics.ot.maintenance} is under maintenance.`,
        `${state.otBacklog.length} surgical request(s) are outstanding${multiResourceCase && multiResourceCase.needsOt ? `, including emergency case ${multiResourceCase.id}` : ''}.`,
        'When no theatre is free the operational routes are: review the running list with the theatre coordinator, or escalate for authorized review. A scheduled procedure is never cancelled automatically.',
      ],
      reason: `${state.otBacklog.length} surgical request(s) against ${metrics.ot.available} free theatre(s).`,
      requiresApproval: true,
      quantity: otHold.length,
      options: otHold.map((theatre) => ({
        id: theatre.theatreId,
        label: `Hold ${theatre.theatreId}`,
        detail: theatre.reason,
        recommended: true,
        effect: { kind: 'OT_HOLD', theatreIds: [theatre.theatreId] },
      })),
      effect: { kind: 'OT_HOLD', theatreIds: otHold.map((theatre) => theatre.theatreId) },
      score: { free: metrics.ot.available, backlog: state.otBacklog.length },
    });
  }

  /* ------------------------------------------- 7. emergency resources */
  const emergencyGap = Math.max(
    0,
    metrics.queue.emergencyBedRequests + metrics.queue.resusRequests - emergencyWard.available,
  );
  if (emergencyGap > 0) {
    recommendations.push({
      id: 'REC-EMG-01',
      resource: 'Emergency Resources',
      resourceCode: 'EMERGENCY_RESOURCE',
      action: 'REINFORCE',
      title: `Emergency bays → Reinforce ${emergencyGap}`,
      highlight: `+${emergencyGap}`,
      summary: `${emergencyGap} monitored emergency bay(s) / resuscitation capacity required beyond current availability.`,
      detail: [
        `${emergencyWard.available} monitored emergency bay(s) are free against ${metrics.queue.emergencyBedRequests} request(s).`,
        `${metrics.queue.resusRequests} resuscitation-bay request(s) recorded.`,
        'Resuscitation capacity is never withheld — this is a capacity reinforcement proposal for authorised review.',
      ],
      reason: `Emergency monitored-bay demand exceeds availability by ${emergencyGap}.`,
      requiresApproval: true,
      quantity: emergencyGap,
      effect: { kind: 'EMERGENCY_REINFORCE', resourceId: 'emergency_beds', note: 'Monitored emergency capacity reinforced for surge intake' },
      score: { available: emergencyWard.available, demand: metrics.queue.emergencyBedRequests },
    });
  }

  /* ------------------------------------------- projection */
  const draft = projectRecommendations(state, recommendations, selections);
  const draftMetrics = calculateHospitalMetrics(draft);
  const placed = projectPlacements(state, draft, state.queue);
  const before = buildSnapshot({ ...state, conflicts }, 'Baseline');
  const after = buildSnapshot({ ...draft, conflicts: [] }, 'Projected');

  const impact = [
    { label: 'Emergency queue', before: metrics.queue.total, after: metrics.queue.total - placed.length, unit: 'patients' },
    { label: 'Critical waiting', before: metrics.queue.critical, after: Math.max(0, metrics.queue.critical - placed.filter((id) => (state.queue.find((entry) => entry.id === id) || {}).priority === 'Critical').length), unit: 'patients' },
    { label: 'ICU vacancy', before: icuWard.available, after: draftMetrics.beds.icu.available, unit: 'beds' },
    { label: 'General beds free', before: generalWard.available, after: draftMetrics.beds.general.available, unit: 'beds' },
    { label: 'Doctors available', before: metrics.doctors.available, after: draftMetrics.doctors.available, unit: 'doctors' },
    { label: 'Nurses deployable', before: metrics.nurses.available, after: draftMetrics.nurses.available, unit: 'nurses' },
    { label: 'Ventilators free', before: freeVentilators, after: draftMetrics.equipment.ventilators ? draftMetrics.equipment.ventilators.free : 0, unit: 'units' },
    { label: 'Theatres free', before: metrics.ot.available, after: draftMetrics.ot.available, unit: 'theatres' },
    { label: 'Resource pressure', before: pressure.overall, after: calculateResourcePressure(draft).overall, unit: '%' },
  ];

  const analysisRows = pressure.resources.map((resource) => ({
    resource: resource.label,
    demand: resource.demand,
    capacity: resource.capacity,
    gap: Math.max(0, resource.demand - resource.capacity),
    pressure: `${resource.pressure}%`,
    band: resource.pressure >= 88 ? 'Critical' : resource.pressure >= 75 ? 'High' : resource.pressure >= 60 ? 'Moderate' : 'Normal',
  }));

  const projectedImpact = {
    queueBefore: metrics.queue.total,
    queueAfter: metrics.queue.total - placed.length,
    criticalQueueBefore: metrics.queue.critical,
    criticalQueueAfter: Math.max(0, metrics.queue.critical - placed.filter((id) => (state.queue.find((entry) => entry.id === id) || {}).priority === 'Critical').length),
    icuGapBefore: Math.max(0, metrics.queue.icuRequests - icuWard.available),
    icuGapAfter: Math.max(0, metrics.queue.icuRequests - draftMetrics.beds.icu.available),
    placementsPossible: placed.length,
  };

  return {
    status: 'RECOMMENDATION_READY',
    generatedAt: new Date(),
    recommendations,
    conflicts,
    impact,
    projectedImpact,
    analysis: {
      pressure,
      before,
      after,
      analysisRows,
      placedPatients: placed,
      multiResourceCase: multiResourceCase ? multiResourceCase.id : null,
    },
  };
}

module.exports = { optimizeResources, projectRecommendations, applyEffect, projectPlacements, cloneState };
