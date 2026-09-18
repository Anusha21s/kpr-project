/**
 * Metrics service — the single place where dashboard numbers are calculated.
 *
 * Every figure is derived from loaded operational state (beds, duties, queue,
 * equipment), so a change in one table immediately changes the dashboards,
 * the pressure model and the optimizer input (§49, §71).
 *
 * Nothing here is a clinical judgement: priority and triage arrive from
 * clinical staff, and MediCore only reports operational capacity (§52).
 */

const { NURSE_WORKLOAD_LIMIT } = require('../../seeds/constants');

const WORKLOAD_WEIGHT = { Low: 35, Moderate: 60, High: 88, Critical: 100 };

const round = (value, places = 1) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const percentage = (part, total) => (total ? round((part / total) * 100, 1) : 0);

const countBy = (list, key, value) => list.filter((entry) => entry[key] === value).length;

/* ------------------------------------------------------------------ beds */

function calculateWardStats(bedUnits) {
  const wardIds = Array.from(new Set(bedUnits.map((unit) => unit.wardId)));
  return wardIds.map((wardId) => {
    const units = bedUnits.filter((unit) => unit.wardId === wardId);
    const available = countBy(units, 'status', 'Available');
    const reserved = countBy(units, 'status', 'Reserved');
    const occupied = countBy(units, 'status', 'Occupied');
    const cleaning = countBy(units, 'status', 'Cleaning');
    const maintenance = countBy(units, 'status', 'Maintenance');
    const escalation = units.filter((unit) => unit.escalation).length;
    return {
      id: wardId,
      name: units[0] ? units[0].ward : wardId,
      short: units[0] ? units[0].wardShort : wardId,
      total: units.length,
      units: units.length,
      baseUnits: units.length - escalation,
      escalation,
      available,
      reserved,
      occupied,
      cleaning,
      maintenance,
      committed: occupied + reserved,
      occupancyPercentage: percentage(units.length - available, units.length),
    };
  });
}

function calculateCapacity(bedUnits) {
  const wards = calculateWardStats(bedUnits);
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
    cleaning: wards.reduce((sum, ward) => sum + ward.cleaning, 0),
    maintenance: wards.reduce((sum, ward) => sum + ward.maintenance, 0),
    occupancyPercentage: percentage(occupied + reserved, total),
  };
}

/* ------------------------------------------------------------------ demand */

function calculateDemandProfile(queue) {
  const byResource = queue.reduce((accumulator, entry) => {
    const key = entry.requiredResource || 'Unassigned';
    accumulator[key] = (accumulator[key] || 0) + 1;
    if (entry.secondaryResource) {
      const secondaryKey = `${entry.secondaryResource} (secondary)`;
      accumulator[secondaryKey] = (accumulator[secondaryKey] || 0) + 1;
    }
    return accumulator;
  }, {});

  const specialistNeeds = queue.reduce((accumulator, entry) => {
    if (!entry.specialtyRequired) return accumulator;
    accumulator[entry.specialtyRequired] = (accumulator[entry.specialtyRequired] || 0) + 1;
    return accumulator;
  }, {});

  const totalWait = queue.reduce((sum, entry) => sum + (entry.waitingMinutes || 0), 0);

  return {
    total: queue.length,
    byResource,
    specialistNeeds,
    icuRequests: queue.filter((entry) => entry.requiredResource === 'ICU Bed' || entry.secondaryResource === 'ICU Bed').length,
    emergencyBedRequests: queue.filter((entry) => entry.requiredResource === 'Emergency Bed').length,
    generalBedRequests: queue.filter((entry) => entry.requiredResource === 'General Bed').length,
    resusRequests: queue.filter((entry) => entry.requiredResource === 'Resuscitation Bay').length,
    ventilatorRequests: queue.filter((entry) => entry.requiresVentilator).length,
    otRequests: queue.filter((entry) => entry.needsOt).length,
    critical: countBy(queue, 'priority', 'Critical'),
    high: countBy(queue, 'priority', 'High'),
    medium: countBy(queue, 'priority', 'Medium'),
    low: countBy(queue, 'priority', 'Low'),
    priorityWeight: queue.reduce((sum, entry) => sum + (WORKLOAD_WEIGHT[entry.priority] || 40), 0),
    averageWait: queue.length ? round(totalWait / queue.length, 1) : 0,
    longestWait: queue.reduce((max, entry) => Math.max(max, entry.waitingMinutes || 0), 0),
  };
}

/* ------------------------------------------------------------------ staff */

/** Doctor eligibility applied by the optimizer (§14): on duty AND available. */
const isDoctorEligible = (doctor) => doctor.dutyStatus === 'ON_DUTY' && doctor.availability === 'Available';
const isNurseEligible = (nurse) =>
  nurse.dutyStatus === 'ON_DUTY' && nurse.availability === 'Available' && nurse.assignedPatients < NURSE_WORKLOAD_LIMIT;

function calculateStaffAnalysis(doctors, nurses) {
  const onDutyDoctors = doctors.filter((doctor) => doctor.dutyStatus === 'ON_DUTY');
  const availableDoctors = onDutyDoctors.filter((doctor) => doctor.availability === 'Available');
  const workloadAverage = (list) =>
    list.length ? Math.round(list.reduce((sum, entry) => sum + (WORKLOAD_WEIGHT[entry.workload] || 50), 0) / list.length) : 0;

  const onDutyNurses = nurses.filter((nurse) => nurse.dutyStatus === 'ON_DUTY');
  const availableNurses = onDutyNurses.filter((nurse) => nurse.availability === 'Available');
  const nursesAtConstraint = onDutyNurses.filter((nurse) => nurse.assignedPatients >= NURSE_WORKLOAD_LIMIT);

  return {
    doctors: {
      total: doctors.length,
      onDuty: onDutyDoctors.length,
      available: availableDoctors.length,
      busy: onDutyDoctors.filter((doctor) => ['Assigned', 'InProcedure'].includes(doctor.availability)).length,
      unavailable: onDutyDoctors.filter((doctor) => doctor.availability === 'Unavailable').length,
      offDuty: doctors.length - onDutyDoctors.length,
      onLeave: doctors.filter((doctor) => doctor.dutyStatus === 'LEAVE').length,
      workloadIndex: workloadAverage(onDutyDoctors),
      highWorkload: onDutyDoctors.filter((doctor) => doctor.workload === 'High').length,
      averagePatients: onDutyDoctors.length
        ? round(onDutyDoctors.reduce((sum, doctor) => sum + doctor.patients, 0) / onDutyDoctors.length, 1)
        : 0,
      availableList: availableDoctors,
      bySpecialty: Array.from(
        doctors.reduce((accumulator, doctor) => {
          const entry = accumulator.get(doctor.specialty) || { specialty: doctor.specialty, total: 0, onDuty: 0, available: 0 };
          entry.total += 1;
          if (doctor.dutyStatus === 'ON_DUTY') {
            entry.onDuty += 1;
            if (doctor.availability === 'Available') entry.available += 1;
          }
          accumulator.set(doctor.specialty, entry);
          return accumulator;
        }, new Map()).values(),
      ).sort((a, b) => a.specialty.localeCompare(b.specialty)),
    },
    nurses: {
      total: nurses.length,
      onDuty: onDutyNurses.length,
      available: availableNurses.length,
      assigned: onDutyNurses.filter((nurse) => nurse.availability === 'Assigned').length,
      offDuty: nurses.length - onDutyNurses.length,
      workloadIndex: workloadAverage(onDutyNurses),
      highWorkload: onDutyNurses.filter((nurse) => nurse.workload === 'High').length,
      atConstraint: nursesAtConstraint.length,
      averagePatients: onDutyNurses.length
        ? round(onDutyNurses.reduce((sum, nurse) => sum + nurse.assignedPatients, 0) / onDutyNurses.length, 1)
        : 0,
      workloadLimit: NURSE_WORKLOAD_LIMIT,
      availableList: availableNurses,
      byDepartment: Array.from(
        nurses.reduce((accumulator, nurse) => {
          const entry =
            accumulator.get(nurse.department) ||
            { department: nurse.department, total: 0, onDuty: 0, available: 0, atConstraint: 0, assignedPatients: 0 };
          entry.total += 1;
          entry.assignedPatients += nurse.assignedPatients;
          if (nurse.dutyStatus === 'ON_DUTY') {
            entry.onDuty += 1;
            if (nurse.availability === 'Available') entry.available += 1;
            if (nurse.assignedPatients >= NURSE_WORKLOAD_LIMIT) entry.atConstraint += 1;
          }
          accumulator.set(nurse.department, entry);
          return accumulator;
        }, new Map()).values(),
      ),
    },
  };
}

/* ------------------------------------------------------------------ equipment */

function calculateEquipmentAnalysis(equipment) {
  const categories = equipment.map((category) => {
    const available = Math.max(category.total - category.inUse, 0);
    const reserved = category.reserved || 0;
    return {
      ...category,
      available,
      reserved,
      free: Math.max(available - reserved, 0),
      utilisation: percentage(category.inUse, category.total),
    };
  });
  const totalUnits = categories.reduce((sum, entry) => sum + entry.total, 0);
  const inUseUnits = categories.reduce((sum, entry) => sum + entry.inUse, 0);
  const byKind = (kind) => categories.filter((entry) => entry.kind === kind);
  return {
    categories,
    totalUnits,
    inUseUnits,
    reservedUnits: categories.reduce((sum, entry) => sum + entry.reserved, 0),
    availableUnits: Math.max(totalUnits - inUseUnits, 0),
    utilisation: percentage(inUseUnits, totalUnits),
    ventilators: categories.find((entry) => entry.id === 'ventilators'),
    monitors: categories.find((entry) => entry.id === 'monitors' || entry.kind === 'MONITOR'),
    otEquipment: categories.find((entry) => entry.kind === 'OT_EQUIPMENT'),
    byKind,
  };
}

function calculateOtAnalysis(otRooms) {
  return {
    rooms: otRooms,
    active: otRooms.filter((room) => ['Ongoing', 'Scheduled'].includes(room.status)).length,
    ongoing: otRooms.filter((room) => room.status === 'Ongoing').length,
    scheduled: otRooms.filter((room) => room.status === 'Scheduled').length,
    available: otRooms.filter((room) => room.status === 'Available').length,
    held: otRooms.filter((room) => room.status === 'Held').length,
    maintenance: otRooms.filter((room) => room.status === 'Maintenance').length,
    total: otRooms.length,
    list: otRooms,
    conflicts: otRooms.filter((room) => room.conflict).length,
  };
}

/* ------------------------------------------------------------------ pressure */

/**
 * Operational pressure = 60% utilisation + 40% unmet-demand share (0-100).
 * These bands are operational indicators, never clinical thresholds (§50).
 */
function calculateResourcePressure(state) {
  const capacity = calculateCapacity(state.bedUnits);
  const demand = calculateDemandProfile(state.queue);
  const staff = calculateStaffAnalysis(state.doctors, state.nurses);
  const equipmentAnalysis = calculateEquipmentAnalysis(state.equipment);
  const ot = calculateOtAnalysis(state.otRooms);

  const pressurise = (utilisation, unmetDemand, totalDemand) => {
    const unmetShare = totalDemand > 0 ? Math.min((unmetDemand / totalDemand) * 100, 100) : 0;
    return Math.max(0, Math.min(100, Math.round(utilisation * 0.6 + unmetShare * 0.4)));
  };

  const ward = (id) => capacity.wards.find((entry) => entry.id === id) || { available: 0, occupancyPercentage: 0, units: 0, committed: 0 };
  const icuWard = ward('icu');
  const generalWard = ward('general');
  const emergencyWard = ward('emergency');
  const ventilators = equipmentAnalysis.ventilators;

  const icuUnmet = Math.max(0, demand.icuRequests - icuWard.available);
  const emergencyUnmet = Math.max(0, demand.emergencyBedRequests - emergencyWard.available);
  const generalUnmet = Math.max(0, demand.generalBedRequests - generalWard.available);
  const otUnmet = Math.max(0, state.otBacklog.length - ot.available);
  const ventilatorUnmet = Math.max(0, demand.ventilatorRequests - (ventilators ? ventilators.free : 0));
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
      pressure: pressurise(emergencyWard.occupancyPercentage, emergencyUnmet, demand.emergencyBedRequests),
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
      utilisation: percentage(ot.active, ot.total),
      demand: Math.max(state.otBacklog.length, ot.active),
      capacity: ot.available,
      unmet: otUnmet,
      pressure: pressurise(percentage(ot.active, ot.total), otUnmet, Math.max(state.otBacklog.length, ot.active)),
      detail: `${ot.active}/${ot.total} theatres active · ${ot.available} available`,
    },
    {
      id: 'equipment',
      label: 'Equipment',
      utilisation: equipmentAnalysis.utilisation,
      demand: demand.ventilatorRequests,
      capacity: ventilators ? ventilators.free : 0,
      unmet: ventilatorUnmet,
      pressure: pressurise(
        equipmentAnalysis.utilisation,
        ventilatorUnmet,
        Math.max(demand.ventilatorRequests, 1),
      ),
      detail: `${equipmentAnalysis.utilisation}% utilised · ${ventilators ? ventilators.free : 0} ventilators available`,
    },
  ];

  const overall = Math.round(resources.reduce((sum, entry) => sum + entry.pressure, 0) / resources.length);
  const band = overall < 60 ? 'NORMAL' : overall < 75 ? 'MODERATE' : overall < 88 ? 'HIGH' : 'CRITICAL';

  return { resources, overall, band, byId: resources.reduce((accumulator, entry) => ({ ...accumulator, [entry.id]: entry }), {}) };
}

/* ------------------------------------------------------------------ aggregate */

function calculateHospitalMetrics(state) {
  const capacity = calculateCapacity(state.bedUnits);
  const demand = calculateDemandProfile(state.queue);
  const staff = calculateStaffAnalysis(state.doctors, state.nurses);
  const equipment = calculateEquipmentAnalysis(state.equipment);
  const ot = calculateOtAnalysis(state.otRooms);
  const pressure = calculateResourcePressure(state);
  const ward = (id) => capacity.wards.find((entry) => entry.id === id) || null;

  const emergencyResources = state.emergencyResources.map((resource) => ({
    ...resource,
    available: Math.max(resource.total - resource.inUse - (resource.reserved || 0), 0),
    utilisation: percentage(resource.inUse, resource.total),
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
      cleaning: capacity.cleaning,
      maintenance: capacity.maintenance,
      occupancyPercentage: capacity.occupancyPercentage,
      wards: capacity.wards,
      general: ward('general'),
      icu: ward('icu'),
      emergency: ward('emergency'),
      maternity: ward('maternity'),
    },
    queue: demand,
    doctors: staff.doctors,
    nurses: staff.nurses,
    equipment: {
      ...equipment,
      ventilators: equipment.categories.find((entry) => entry.id === 'ventilators'),
      monitors: equipment.categories.find((entry) => entry.id === 'monitors'),
      otEquipment: equipment.categories.find((entry) => entry.kind === 'OT_EQUIPMENT'),
    },
    ot,
    emergencyResources,
    pressure,
    conflicts: state.conflicts || [],
    activeAlerts: (state.alerts || []).filter((alert) => alert.status === 'Active'),
    criticalAlerts: (state.alerts || []).filter((alert) => alert.status === 'Active' && alert.type === 'Critical'),
    surgeActive: Boolean(state.surge && state.surge.active),
    surgeProcessed: Boolean(state.surge && state.surge.processed),
    allocations: state.allocations || [],
    pendingApprovals: (state.approvals || []).filter((approval) => approval.status === 'Pending Review'),
  };
}

/** Compact before/after comparison used by the surge simulation (§30). */
function buildSnapshot(state, label) {
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

module.exports = {
  WORKLOAD_WEIGHT,
  round,
  percentage,
  calculateWardStats,
  calculateCapacity,
  calculateDemandProfile,
  calculateStaffAnalysis,
  calculateEquipmentAnalysis,
  calculateOtAnalysis,
  calculateResourcePressure,
  calculateHospitalMetrics,
  buildSnapshot,
  isDoctorEligible,
  isNurseEligible,
};
