/**
 * MediCore simulation engine.
 *
 * Pure, deterministic functions that read hospital state and produce the
 * operational numbers used across every dashboard plus the emergency surge
 * simulation. No random values are used anywhere — the same input state always
 * produces the same output, which keeps the demonstration reproducible.
 *
 * Terminology note: MediCore performs *operational* capacity analysis only.
 * Clinical requirements are always recorded by clinical staff (see
 * `patient.clinicalRequirementBy`) and are treated as inputs, never decisions.
 */

import { SURGE_BATCH, countByPriority } from '../data/patients';
import { BED_STATUS, getWardStats } from '../data/beds';
import { NURSE_WORKLOAD_LIMIT } from '../data/nurses';

export const WORKLOAD_WEIGHT = { Low: 35, Moderate: 60, High: 88, Critical: 100 };

/* ------------------------------------------------------------------ *
 * Capacity / occupancy primitives
 * ------------------------------------------------------------------ */

export const calculateOccupancy = (occupiedBeds, totalBeds) => {
  if (!totalBeds) return 0;
  return Math.round((occupiedBeds / totalBeds) * 1000) / 10;
};

export const calculateCapacity = (bedUnits) => {
  const wards = getWardStats(bedUnits);
  const total = wards.reduce((sum, ward) => sum + ward.units, 0);
  const occupied = wards.reduce((sum, ward) => sum + ward.occupied, 0);
  const reserved = wards.reduce((sum, ward) => sum + ward.reserved, 0);
  const available = wards.reduce((sum, ward) => sum + ward.available, 0);
  const escalation = wards.reduce((sum, ward) => sum + ward.escalation, 0);
  return {
    wards,
    total,
    baseTotal: total - escalation,
    escalation,
    occupied,
    reserved,
    available,
    committed: occupied + reserved,
    occupancyPercentage: calculateOccupancy(occupied + reserved, total),
  };
};

export const calculateBedAvailability = (bedUnits, wardId = null) =>
  bedUnits.filter(
    (unit) => unit.status === BED_STATUS.AVAILABLE && (!wardId || unit.wardId === wardId),
  ).length;

/* ------------------------------------------------------------------ *
 * Demand profile — what the patient queue is asking the hospital for
 * ------------------------------------------------------------------ */

export function calculateDemandProfile(queue) {
  const byResource = queue.reduce((accumulator, entry) => {
    const key = entry.requiredResource;
    accumulator[key] = (accumulator[key] || 0) + 1;
    if (entry.secondaryResource) {
      const secondaryKey = `${entry.secondaryResource} (secondary)`;
      accumulator[secondaryKey] = (accumulator[secondaryKey] || 0) + 1;
    }
    return accumulator;
  }, {});

  const specialistNeeds = queue.reduce((accumulator, entry) => {
    accumulator[entry.specialtyRequired] = (accumulator[entry.specialtyRequired] || 0) + 1;
    return accumulator;
  }, {});

  const priorityWeight = queue.reduce(
    (sum, entry) => sum + (WORKLOAD_WEIGHT[entry.priority] || 40),
    0,
  );

  const totalWait = queue.reduce((sum, entry) => sum + entry.waitingMinutes, 0);

  return {
    total: queue.length,
    byResource,
    specialistNeeds,
    icuRequests: queue.filter(
      (entry) => entry.requiredResource === 'ICU Bed' || entry.secondaryResource === 'ICU Bed',
    ).length,
    emergencyBedRequests: queue.filter((entry) => entry.requiredResource === 'Emergency Bed').length,
    generalBedRequests: queue.filter((entry) => entry.requiredResource === 'General Bed').length,
    resusRequests: queue.filter((entry) => entry.requiredResource === 'Resuscitation Bay').length,
    ventilatorRequests: queue.filter((entry) => entry.requiresVentilator).length,
    otRequests: queue.filter((entry) => entry.needsOt).length,
    critical: countByPriority(queue, 'Critical'),
    high: countByPriority(queue, 'High'),
    medium: countByPriority(queue, 'Medium'),
    low: countByPriority(queue, 'Low'),
    priorityWeight,
    averageWait: queue.length ? Math.round((totalWait / queue.length) * 10) / 10 : 0,
    longestWait: queue.reduce((max, entry) => Math.max(max, entry.waitingMinutes), 0),
  };
}

/* ------------------------------------------------------------------ *
 * Staff + equipment analysis
 * ------------------------------------------------------------------ */

/** A doctor is eligible for a recommendation only when ALL of these hold. */
export function isDoctorEligible(doctor) {
  return (
    doctor.dutyStatus === 'ON_DUTY' &&
    doctor.availability === 'Available' &&
    doctor.withinShift !== false
  );
}

export function calculateStaffAnalysis(doctors, nurses) {
  const onDutyDoctors = doctors.filter((doctor) => doctor.dutyStatus === 'ON_DUTY');
  const availableDoctors = onDutyDoctors.filter((doctor) => doctor.availability === 'Available');
  const busyDoctors = onDutyDoctors.filter((doctor) => doctor.availability === 'Busy');
  const unavailableDoctors = onDutyDoctors.filter((doctor) => doctor.availability === 'Unavailable');

  const workloadAverage = (list) =>
    list.length
      ? Math.round(list.reduce((sum, entry) => sum + (WORKLOAD_WEIGHT[entry.workload] || 50), 0) / list.length)
      : 0;

  const onDutyNurses = nurses.filter((nurse) => nurse.dutyStatus === 'ON_DUTY');
  const availableNurses = onDutyNurses.filter((nurse) => nurse.availability === 'Available');
  const assignedNurses = onDutyNurses.filter((nurse) => nurse.availability === 'Assigned');
  const nursesAtConstraint = onDutyNurses.filter(
    (nurse) => nurse.assignedPatients >= NURSE_WORKLOAD_LIMIT,
  );

  return {
    doctors: {
      total: doctors.length,
      onDuty: onDutyDoctors.length,
      available: availableDoctors.length,
      busy: busyDoctors.length,
      unavailable: unavailableDoctors.length,
      offDuty: doctors.length - onDutyDoctors.length,
      workloadIndex: workloadAverage(onDutyDoctors),
      highWorkload: onDutyDoctors.filter((doctor) => doctor.workload === 'High').length,
      availableList: availableDoctors,
    },
    nurses: {
      total: nurses.length,
      onDuty: onDutyNurses.length,
      available: availableNurses.length,
      assigned: assignedNurses.length,
      offDuty: nurses.length - onDutyNurses.length,
      workloadIndex: workloadAverage(onDutyNurses),
      highWorkload: onDutyNurses.filter((nurse) => nurse.workload === 'High').length,
      atConstraint: nursesAtConstraint.length,
      averagePatients: onDutyNurses.length
        ? Math.round(
            (onDutyNurses.reduce((sum, nurse) => sum + nurse.assignedPatients, 0) / onDutyNurses.length) * 10,
          ) / 10
        : 0,
      workloadLimit: NURSE_WORKLOAD_LIMIT,
      availableList: availableNurses,
    },
  };
}

export function calculateEquipmentAnalysis(equipment) {
  const categories = equipment.map((category) => {
    const available = category.total - category.inUse;
    return {
      ...category,
      available,
      reserved: category.reserved || 0,
      free: Math.max(available - (category.reserved || 0), 0),
      utilisation: calculateOccupancy(category.inUse, category.total),
    };
  });
  const totalUnits = categories.reduce((sum, entry) => sum + entry.total, 0);
  const inUseUnits = categories.reduce((sum, entry) => sum + entry.inUse, 0);
  return {
    categories,
    totalUnits,
    inUseUnits,
    availableUnits: totalUnits - inUseUnits,
    utilisation: calculateOccupancy(inUseUnits, totalUnits),
  };
}

export function calculateOtAnalysis(otRooms) {
  return {
    rooms: otRooms,
    active: otRooms.filter((room) => ['Ongoing', 'Scheduled'].includes(room.status)).length,
    available: otRooms.filter((room) => room.status === 'Available').length,
    maintenance: otRooms.filter((room) => room.status === 'Maintenance').length,
    total: otRooms.length,
    list: otRooms,
  };
}

/* ------------------------------------------------------------------ *
 * Pressure model
 *
 * pressure = 60% resource utilisation + 40% unmet demand share, clamped 0-100.
 * Unmet demand = patients requiring the resource minus committed capacity.
 * The model is intentionally simple and fully visible in the UI so the
 * operations team can see exactly why a resource is flagged.
 * ------------------------------------------------------------------ */
export function calculateResourcePressure(state) {
  const capacity = calculateCapacity(state.bedUnits);
  const demand = calculateDemandProfile(state.queue);
  const staff = calculateStaffAnalysis(state.doctors, state.nurses);
  const equipmentAnalysis = calculateEquipmentAnalysis(state.equipment);
  const ot = calculateOtAnalysis(state.otRooms);

  const pressurise = (utilisation, unmetDemand, totalDemand) => {
    const unmetShare = totalDemand > 0 ? Math.min((unmetDemand / totalDemand) * 100, 100) : 0;
    return Math.max(0, Math.min(100, Math.round(utilisation * 0.6 + unmetShare * 0.4)));
  };

  const icuWard = capacity.wards.find((ward) => ward.id === 'icu');
  const emergencyWard = capacity.wards.find((ward) => ward.id === 'emergency');
  const generalWard = capacity.wards.find((ward) => ward.id === 'general');

  const ventilatorCategory = equipmentAnalysis.categories.find((entry) => entry.id === 'ventilators');

  const icuUnmet = Math.max(0, demand.icuRequests - (icuWard.available + (icuWard.escalated || 0)));
  const emergencyUnmet = Math.max(
    0,
    demand.emergencyBedRequests - (emergencyWard.available + (emergencyWard.escalated || 0)),
  );
  const generalUnmet = Math.max(0, demand.generalBedRequests - generalWard.available);
  const otUnmet = Math.max(0, state.otBacklog.length - ot.available);
  const nurseUnmet = Math.max(0, staff.nurses.atConstraint - staff.nurses.available + 1) * 4;

  const resources = [
    {
      id: 'icu',
      label: 'ICU Capacity',
      utilisation: icuWard.occupancyPercentage,
      demand: demand.icuRequests,
      capacity: icuWard.available,
      unmet: icuUnmet,
      pressure: pressurise(icuWard.occupancyPercentage, icuUnmet, demand.icuRequests),
      detail: `${icuWard.committed}/${icuWard.units} beds committed · ${demand.icuRequests} ICU requests`,
    },
    {
      id: 'beds',
      label: 'General Beds',
      utilisation: generalWard.occupancyPercentage,
      demand: demand.generalBedRequests,
      capacity: generalWard.available,
      unmet: generalUnmet,
      pressure: pressurise(generalWard.occupancyPercentage, generalUnmet, demand.generalBedRequests),
      detail: `${generalWard.available} general beds available · ${demand.generalBedRequests} requests`,
    },
    {
      id: 'emergency',
      label: 'Emergency Beds',
      utilisation: emergencyWard.occupancyPercentage,
      demand: demand.emergencyBedRequests,
      capacity: emergencyWard.available,
      unmet: emergencyUnmet,
      pressure: pressurise(
        emergencyWard.occupancyPercentage,
        emergencyUnmet,
        demand.emergencyBedRequests,
      ),
      detail: `${emergencyWard.available} emergency beds free · ${demand.emergencyBedRequests} requests`,
    },
    {
      id: 'doctors',
      label: 'Medical Staff',
      utilisation: staff.doctors.workloadIndex,
      demand: demand.total,
      capacity: staff.doctors.available,
      unmet: Math.max(0, staff.doctors.highWorkload - staff.doctors.available),
      pressure: pressurise(staff.doctors.workloadIndex, Math.max(0, demand.critical - staff.doctors.available), demand.total),
      detail: `${staff.doctors.onDuty} on duty · ${staff.doctors.available} available`,
    },
    {
      id: 'nurses',
      label: 'Nursing Staff',
      utilisation: staff.nurses.workloadIndex,
      demand: demand.total,
      capacity: staff.nurses.available,
      unmet: nurseUnmet,
      pressure: pressurise(staff.nurses.workloadIndex, nurseUnmet, Math.max(demand.total, 1)),
      detail: `${staff.nurses.atConstraint} nurses at workload limit · ${staff.nurses.available} available`,
    },
    {
      id: 'ot',
      label: 'OT Capacity',
      utilisation: calculateOccupancy(ot.active, ot.total),
      demand: Math.max(state.otBacklog.length, ot.active),
      capacity: ot.available,
      unmet: otUnmet,
      pressure: pressurise(calculateOccupancy(ot.active, ot.total), otUnmet, Math.max(state.otBacklog.length, ot.active)),
      detail: `${ot.active}/${ot.total} theatres active · ${ot.available} available`,
    },
    {
      id: 'equipment',
      label: 'Equipment',
      utilisation: equipmentAnalysis.utilisation,
      demand: demand.ventilatorRequests,
      capacity: ventilatorCategory ? ventilatorCategory.available : 0,
      unmet: Math.max(0, demand.ventilatorRequests - (ventilatorCategory ? ventilatorCategory.available : 0)),
      pressure: pressurise(
        equipmentAnalysis.utilisation,
        Math.max(0, demand.ventilatorRequests - (ventilatorCategory ? ventilatorCategory.available : 0)),
        Math.max(demand.ventilatorRequests, 1),
      ),
      detail: `${equipmentAnalysis.utilisation}% utilised · ${
        ventilatorCategory ? ventilatorCategory.available : 0
      } ventilators available`,
    },
  ];

  const overall = Math.round(
    resources.reduce((sum, entry) => sum + entry.pressure, 0) / resources.length,
  );

  return { resources, overall, byId: resources.reduce((acc, entry) => ({ ...acc, [entry.id]: entry }), {}) };
}

/* ------------------------------------------------------------------ *
 * Aggregate metrics — the single object every dashboard renders from
 * ------------------------------------------------------------------ */

export function calculateHospitalMetrics(state) {
  const capacity = calculateCapacity(state.bedUnits);
  const demand = calculateDemandProfile(state.queue);
  const staff = calculateStaffAnalysis(state.doctors, state.nurses);
  const equipment = calculateEquipmentAnalysis(state.equipment);
  const ot = calculateOtAnalysis(state.otRooms);
  const pressure = calculateResourcePressure(state);

  const icuWard = capacity.wards.find((ward) => ward.id === 'icu');
  const emergencyWard = capacity.wards.find((ward) => ward.id === 'emergency');
  const generalWard = capacity.wards.find((ward) => ward.id === 'general');

  const emergencyResources = state.emergencyResources.map((resource) => ({
    ...resource,
    available: resource.total - resource.inUse,
    utilisation: calculateOccupancy(resource.inUse, resource.total),
  }));

  return {
    beds: {
      total: capacity.total,
      baseTotal: capacity.baseTotal,
      escalation: capacity.escalation,
      occupied: capacity.occupied,
      reserved: capacity.reserved,
      committed: capacity.committed,
      available: capacity.available,
      occupancyPercentage: capacity.occupancyPercentage,
      wards: capacity.wards,
      general: generalWard,
      icu: icuWard,
      emergency: emergencyWard,
      maternity: capacity.wards.find((ward) => ward.id === 'maternity'),
    },
    queue: demand,
    doctors: staff.doctors,
    nurses: staff.nurses,
    equipment: {
      ...equipment,
      ventilators: equipment.categories.find((entry) => entry.id === 'ventilators'),
      monitors: equipment.categories.find((entry) => entry.id === 'monitors'),
      otEquipment: equipment.categories.find((entry) => entry.id === 'ot'),
    },
    ot,
    emergencyResources,
    pressure,
    conflicts: state.conflicts || [],
    activeAlerts: (state.alerts || []).filter((alert) => alert.status === 'Active'),
    criticalAlerts: (state.alerts || []).filter(
      (alert) => alert.status === 'Active' && alert.type === 'Critical',
    ),
    surgeActive: Boolean(state.surge?.active),
    surgeProcessed: Boolean(state.surge?.processed),
    allocations: state.allocations || [],
    pendingApprovals: (state.approvals || []).filter((approval) => approval.status === 'Pending Review'),
  };
}

/** Compact snapshot used for before / surge / after comparisons. */
export function buildSnapshot(state, label) {
  const metrics = calculateHospitalMetrics(state);
  return {
    label,
    emergencyQueue: metrics.queue.total,
    criticalQueue: metrics.queue.critical,
    icuOccupancy: metrics.beds.icu.occupancyPercentage,
    icuAvailable: metrics.beds.icu.available,
    availableBeds: metrics.beds.available,
    doctorsAvailable: metrics.doctors.available,
    doctorWorkload: metrics.doctors.workloadIndex,
    nursesAvailable: metrics.nurses.available,
    nurseWorkload: metrics.nurses.workloadIndex,
    equipmentUtilisation: metrics.equipment.utilisation,
    ventilatorsAvailable: metrics.equipment.ventilators.available,
    otAvailable: metrics.ot.available,
    pressure: metrics.pressure.overall,
    conflicts: metrics.conflicts.length,
  };
}

/* ------------------------------------------------------------------ *
 * Emergency surge simulation
 * ------------------------------------------------------------------ */

/**
 * Applies the deterministic surge batch (+20 emergency patients) to a draft of
 * the hospital state and returns both the new state and the operational deltas.
 *
 * Surge behaviour, in operational terms:
 *  - 20 patients are added to the emergency queue
 *  - vacant monitored beds that are not already committed are held for the
 *    incoming critical arrivals (a provisional hold, not a clinical decision)
 *  - the last ICU bed is committed to the highest-acuity ICU case, so the
 *    multi-resource conflict card can report "ICU → 0 available" for other cases
 *  - staff workload and equipment utilisation rise because of the added demand
 */
export function simulateEmergencySurge(state) {
  const draft = {
    ...state,
    bedUnits: state.bedUnits.map((unit) => ({ ...unit })),
    doctors: state.doctors.map((doctor) => ({ ...doctor })),
    nurses: state.nurses.map((nurse) => ({ ...nurse })),
    equipment: state.equipment.map((category) => ({ ...category, units: [...category.units] })),
    emergencyResources: state.emergencyResources.map((resource) => ({ ...resource })),
  };

  const before = buildSnapshot(state, 'Baseline');
  draft.queue = [...state.queue, ...SURGE_BATCH.map((entry) => ({ ...entry }))];

  // Provisional holds so incoming critical patients are not exposed to bed churn.
  const holdPlan = [
    { wardId: 'emergency', count: 2, reason: 'Held for incoming critical emergency arrivals (P015, P016)' },
    { wardId: 'general', count: 7, reason: 'Held for surge admissions and emergency step-down transfers' },
    { wardId: 'icu', count: 1, reason: 'Committed to highest-acuity ICU case P009 (RTA polytrauma)' },
  ];

  const heldBeds = [];
  holdPlan.forEach((plan) => {
    let remaining = plan.count;
    draft.bedUnits = draft.bedUnits.map((unit) => {
      if (remaining > 0 && unit.wardId === plan.wardId && unit.status === BED_STATUS.AVAILABLE) {
        remaining -= 1;
        heldBeds.push(unit.id);
        return { ...unit, status: BED_STATUS.RESERVED, heldFor: plan.reason };
      }
      return unit;
    });
  });

  draft.emergencyResources = draft.emergencyResources.map((resource) => {
    if (resource.id === 'resus') {
      return {
        ...resource,
        inUse: Math.min(resource.total, resource.inUse + 1),
        heldFor: 'Resuscitation bay held for incoming cardiac emergency (P028)',
      };
    }
    if (resource.id === 'trauma-kits') {
      return { ...resource, inUse: Math.min(resource.total, resource.inUse + 2) };
    }
    if (resource.id === 'ambulances') {
      return { ...resource, heldFor: '1 additional ambulance placed on standby for surge intake' };
    }
    return resource;
  });

  /**
   * Workload pressure from the added demand (operational load only — MediCore
   * never redistributes clinical responsibility without a coordinator).
   * Availability itself is preserved so the coordinator still has a deployable
   * pool to allocate from.
   */
  const workloadLift = { Low: 'Moderate', Moderate: 'High', High: 'High' };
  draft.doctors = draft.doctors.map((doctor) => {
    if (doctor.dutyStatus !== 'ON_DUTY') return doctor;
    return {
      ...doctor,
      workload: workloadLift[doctor.workload] || doctor.workload,
      patients: doctor.patients + (doctor.availability === 'Available' ? 2 : 3),
      currentAssignment:
        doctor.availability === 'Available'
          ? 'Surge response standby — awaiting coordinator deployment'
          : doctor.currentAssignment,
    };
  });

  draft.nurses = draft.nurses.map((nurse) => {
    if (nurse.dutyStatus !== 'ON_DUTY') return nurse;
    const patients = nurse.assignedPatients + 1;
    const isStandby = nurse.availability === 'Available';
    return {
      ...nurse,
      assignedPatients: patients,
      workload: isStandby ? 'Moderate' : patients >= 5 ? 'High' : patients >= 3 ? 'Moderate' : 'Low',
      currentAssignment: isStandby
        ? 'Surge response pool — standby for ICU / emergency cover'
        : nurse.currentAssignment,
    };
  });

  /**
   * Equipment: monitors and OT equipment are drawn down by the arriving
   * casualties. Ventilators remain 12/15 in use with 2 units free, which is the
   * constraint the optimisation engine then reserves.
   */
  draft.equipment = draft.equipment.map((category) => {
    if (category.id === 'monitors') {
      return { ...category, inUse: Math.min(category.total - 3, category.inUse + 4) };
    }
    if (category.id === 'ot') {
      return { ...category, inUse: Math.min(category.total - 2, category.inUse + 1) };
    }
    return category;
  });

  draft.otBacklog = [
    ...state.otBacklog,
    {
      id: 'OTR-04',
      patientId: 'P010',
      requirement: 'Emergency surgical review — possible laparotomy',
      urgency: 'Critical',
      requestedBy: 'Emergency Medicine',
    },
  ];

  draft.surge = {
    active: true,
    processed: false,
    patientsAdded: SURGE_BATCH.length,
    startedAt: new Date().toISOString(),
    heldBeds,
    batchIds: SURGE_BATCH.map((entry) => entry.id),
  };
  draft.simulationHistory = draft.simulationHistory || {};
  draft.simulationHistory.before = before;

  const after = buildSnapshot(draft, 'After surge');

  return {
    state: draft,
    before,
    after,
    deltas: buildDeltas(before, after),
    heldBeds,
    patientsAdded: SURGE_BATCH.length,
  };
}

export function buildDeltas(before, after) {
  const keys = [
    ['emergencyQueue', 'Emergency queue', 'patients'],
    ['criticalQueue', 'Critical cases', 'patients'],
    ['icuOccupancy', 'ICU occupancy', '%'],
    ['availableBeds', 'Available beds', 'beds'],
    ['doctorsAvailable', 'Doctors available', 'staff'],
    ['doctorWorkload', 'Doctor workload', 'index'],
    ['nursesAvailable', 'Nurses available', 'staff'],
    ['nurseWorkload', 'Nurse workload', 'index'],
    ['equipmentUtilisation', 'Equipment utilisation', '%'],
    ['pressure', 'Overall resource pressure', 'index'],
  ];
  return keys.map(([key, label, unit]) => ({
    key,
    label,
    unit,
    before: before[key],
    after: after[key],
    delta: Math.round((after[key] - before[key]) * 10) / 10,
  }));
}

/** Restores the hospital to its authored baseline. */
export function resetSimulation(initialStateFactory) {
  return typeof initialStateFactory === 'function' ? initialStateFactory() : initialStateFactory;
}
