/**
 * Hospital state repository.
 *
 * Reads the operational tables once and projects them into the exact state
 * shape the MediCore dashboards already render (the frontend contract, §2).
 * Nothing here calculates a dashboard number — this file only loads and maps.
 * All derived figures live in `services/metricsService.js` so a bed, a duty
 * change or a new queue patient propagates through every screen (§71).
 */

const { prisma } = require('../config/database');
const { currentShift } = require('../utils/time');

/* ------------------------------------------------------------------ mapping */

const BED_STATUS_TO_UI = {
  AVAILABLE: 'Available',
  OCCUPIED: 'Occupied',
  RESERVED: 'Reserved',
  CLEANING: 'Cleaning',
  MAINTENANCE: 'Maintenance',
};

const THEATRE_STATUS_TO_UI = {
  AVAILABLE: 'Available',
  ONGOING: 'Ongoing',
  SCHEDULED: 'Scheduled',
  MAINTENANCE: 'Maintenance',
  HELD: 'Held',
};

const OT_SLOT_STATUS_TO_UI = {
  SCHEDULED: 'Scheduled',
  ONGOING: 'Ongoing',
  COMPLETED: 'Completed',
  HELD: 'Held',
  CANCELLED: 'Cancelled',
};

const QUEUE_STATUS_TO_UI = {
  WAITING: 'Waiting',
  ALLOCATION_PROPOSED: 'Allocation Proposed',
  ALLOCATED: 'Allocated',
  IN_TREATMENT: 'In Treatment',
  CLOSED: 'Closed',
};

const ALERT_STATUS_TO_UI = { ACTIVE: 'Active', ACKNOWLEDGED: 'Acknowledged', RESOLVED: 'Resolved' };

const APPROVAL_STATUS_TO_UI = {
  PENDING_REVIEW: 'Pending Review',
  APPROVED: 'Confirmed',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

const ALLOCATION_STATUS_TO_UI = {
  PROPOSED: 'Proposed',
  PENDING_APPROVAL: 'Pending Approval',
  CONFIRMED: 'Confirmed',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

const WARD_LABELS = {
  general: { name: 'General Ward', short: 'GEN' },
  icu: { name: 'Intensive Care Unit', short: 'ICU' },
  emergency: { name: 'Emergency Ward', short: 'EMG' },
  maternity: { name: 'Maternity & Paediatrics', short: 'MAT' },
};

/** DB bed row → the unit shape the bed boards render. */
const toBedUnit = (bed) => ({
  id: bed.id,
  wardId: bed.wardId,
  ward: bed.ward,
  bedType: bed.bedType,
  wardShort: WARD_LABELS[bed.wardId] ? WARD_LABELS[bed.wardId].short : bed.wardId,
  status: BED_STATUS_TO_UI[bed.status] || 'Available',
  statusCode: bed.status,
  patient: bed.patient ? (bed.patientRef || bed.patient.patientNumber) : null,
  patientId: bed.patientId,
  features: bed.features || [],
  heldFor: bed.heldFor,
  availableFrom: bed.availableFrom,
  escalation: Boolean(bed.escalation),
  notes: bed.notes,
});

const toDoctor = (doctor) => ({
  id: doctor.id,
  name: doctor.name,
  specialty: doctor.specialty,
  department: doctor.department,
  dutyStatus: doctor.dutyStatus,
  availability: doctor.availability,
  currentAssignment: doctor.currentAssignment,
  workload: doctor.workload,
  patients: doctor.patients,
  maxOperationalLoad: doctor.maxOperationalLoad,
  since: doctor.since,
  contact: doctor.contact,
  shiftBlock: doctor.shiftBlock,
  shift: doctor.shift,
  hasAccount: Boolean(doctor.userId),
});

const toNurse = (nurse) => ({
  id: nurse.id,
  name: nurse.name,
  department: nurse.department,
  dutyStatus: nurse.dutyStatus,
  availability: nurse.availability,
  currentAssignment: nurse.currentAssignment,
  workload: nurse.workload,
  assignedPatients: nurse.assignedPatients,
  maxOperationalLoad: nurse.maxOperationalLoad,
  shiftBlock: nurse.shiftBlock,
  shift: nurse.shift,
  hasAccount: Boolean(nurse.userId),
});

const toEquipment = (category) => ({
  id: category.id,
  name: category.name,
  kind: category.kind,
  description: category.description,
  total: category.total,
  inUse: category.inUse,
  reserved: category.reserved,
  location: category.location,
  status: category.status,
  criticalFor: category.criticalFor,
  units: (category.units || []).map((unit) => ({
    id: unit.id,
    inUse: unit.inUse,
    reserved: unit.reserved,
    status: unit.status,
    reservedFor: unit.reservedFor,
  })),
});

const toEmergencyResource = (resource) => {
  const available = Math.max(resource.total - resource.inUse - resource.reserved, 0);
  return {
    id: resource.id,
    name: resource.name,
    kind: resource.kind,
    total: resource.total,
    inUse: resource.inUse,
    reserved: resource.reserved,
    available,
    free: Math.max(resource.total - resource.inUse, 0),
    utilisation: resource.total ? Math.round((resource.inUse / resource.total) * 1000) / 10 : 0,
    location: resource.location,
    status: resource.status,
    criticalFor: resource.criticalFor,
    heldFor: null,
  };
};

const toTheatre = (theatre) => {
  const slot = (theatre.schedule || []).find((entry) => ['ONGOING', 'SCHEDULED', 'HELD'].includes(entry.status));
  return {
    id: theatre.id,
    name: theatre.name,
    kind: theatre.kind,
    status: THEATRE_STATUS_TO_UI[theatre.status] || 'Available',
    statusCode: theatre.status,
    start: slot ? slot.start : null,
    end: slot ? slot.end : null,
    startMinutes: slot ? slot.startMinutes : null,
    endMinutes: slot ? slot.endMinutes : null,
    procedure: slot ? slot.procedure : theatre.status === 'MAINTENANCE' ? 'Equipment maintenance' : 'No procedure scheduled',
    surgeon: slot ? slot.surgeonName || 'Unassigned' : 'Unassigned',
    surgeonRef: slot ? slot.surgeonId : null,
    anaesthetist: slot ? slot.anaesthetist || 'Unassigned' : 'Unassigned',
    patientId: slot ? slot.patientId : null,
    patientLabel: slot ? slot.patientLabel : null,
    requiredEquipment: slot ? slot.requiredEquipment : [],
    equipmentReady: slot ? slot.equipmentReady : true,
    nurses: slot ? slot.nurses : [],
    notes: slot ? slot.notes || theatre.notes : theatre.notes,
    nextAvailableSlot: theatre.nextAvailableSlot,
    nextAvailableMinutes: theatre.nextAvailableMinutes,
    scheduleId: slot ? slot.id : null,
    conflict: slot ? Boolean(slot.conflict) : false,
    conflictDetail: slot ? slot.conflictDetail : null,
  };
};

const toOtBacklogRow = (slot) => ({
  id: slot.id,
  reference: slot.reference || slot.id,
  patientId: slot.patientId,
  patientNumber: slot.patient ? slot.patient.patientNumber : null,
  patientLabel: slot.patientLabel || (slot.patient ? slot.patient.patientNumber : 'Unassigned'),
  procedure: slot.procedure,
  priority: slot.priority,
  surgeon: slot.surgeonName || 'Awaiting allocation',
  status: slot.status,
  source: slot.source,
  theatreId: slot.theatreId,
});

const toQueueEntry = (entry) => {
  const patient = entry.patient;
  return {
    id: patient.patientNumber,
    patientId: patient.id,
    name: patient.name,
    age: patient.age,
    sex: patient.sex,
    department: patient.department,
    priority: entry.priority,
    triage: entry.triage,
    requiredResource: entry.requiredResource,
    secondaryResource: entry.secondaryResource,
    specialtyRequired: patient.specialtyRequired,
    requiresVentilator: patient.requiresVentilator,
    needsOt: patient.needsOt,
    waitingMinutes: entry.waitingMinutes,
    waitingSince: entry.waitingSince,
    status: QUEUE_STATUS_TO_UI[entry.status] || 'Waiting',
    statusCode: entry.status,
    escalated: entry.escalated,
    clinicalRequirementBy: patient.clinicalRequirementBy,
    requirementConfirmedAt: patient.requirementConfirmedAt,
    notes: patient.notes,
    diagnosis: patient.diagnosis,
    plan: patient.plan,
    assignedDoctor: patient.assignedDoctor ? patient.assignedDoctor.name : null,
    assignedDoctorId: patient.assignedDoctorId,
    assignedNurse: patient.assignedNurse ? patient.assignedNurse.name : null,
    assignedNurseId: patient.assignedNurseId,
    assignedBedId: patient.assignedBedId,
    securedResources: Array.isArray(entry.securedResources) ? entry.securedResources : [],
    position: entry.position,
  };
};

const toPatient = (patient) => ({
  id: patient.id,
  patientNumber: patient.patientNumber,
  name: patient.name,
  age: patient.age,
  sex: patient.sex,
  department: patient.department,
  priority: patient.priority,
  triage: patient.triage,
  requiredResource: patient.requiredResource,
  secondaryResource: patient.secondaryResource,
  specialtyRequired: patient.specialtyRequired,
  requiresVentilator: patient.requiresVentilator,
  needsOt: patient.needsOt,
  waitingMinutes: patient.queueEntry ? patient.queueEntry.waitingMinutes : 0,
  queueStatus: patient.queueEntry ? QUEUE_STATUS_TO_UI[patient.queueEntry.status] : null,
  clinicalRequirementBy: patient.clinicalRequirementBy,
  requirementConfirmedAt: patient.requirementConfirmedAt,
  notes: patient.notes,
  diagnosis: patient.diagnosis,
  plan: patient.plan,
  vitals: patient.vitals,
  status: patient.status,
  assignedDoctorId: patient.assignedDoctorId,
  assignedDoctor: patient.assignedDoctor ? patient.assignedDoctor.name : null,
  assignedNurseId: patient.assignedNurseId,
  assignedNurse: patient.assignedNurse ? patient.assignedNurse.name : null,
  assignedBed: patient.occupiedBed
    ? {
        id: patient.occupiedBed.id,
        ward: patient.occupiedBed.ward,
        wardId: patient.occupiedBed.wardId,
        bedType: patient.occupiedBed.bedType,
        status: BED_STATUS_TO_UI[patient.occupiedBed.status],
      }
    : patient.assignedBedId
      ? { id: patient.assignedBedId, ward: null, wardId: null, bedType: null, status: null }
      : null,
  isSimulated: patient.isSimulated,
  createdAt: patient.createdAt,
  updatedAt: patient.updatedAt,
});

const toAlert = (alert) => ({
  id: alert.reference,
  dbId: alert.id,
  type: alert.type,
  severity: alert.severity,
  category: alert.category,
  title: alert.title,
  description: alert.description,
  resource: alert.resource,
  affectedResource: alert.affectedResource,
  timestamp: alert.createdAt,
  action: alert.actionLabel ? { label: alert.actionLabel, to: alert.actionTo } : null,
  source: alert.source,
  status: ALERT_STATUS_TO_UI[alert.status] || 'Active',
  patientId: alert.patientId,
  patientNumber: alert.patient ? alert.patient.patientNumber : null,
});

const toAllocation = (allocation) => ({
  id: allocation.reference,
  dbId: allocation.id,
  type: allocation.type,
  patientId: allocation.patient ? allocation.patient.patientNumber : null,
  bedId: allocation.bedId,
  doctorId: allocation.doctorId,
  nurseId: allocation.nurseId,
  equipmentId: allocation.equipmentId,
  equipmentUnitId: allocation.equipmentUnitId,
  theatreId: allocation.theatreId,
  quantity: allocation.quantity,
  resourceLabel: allocation.resourceLabel,
  status: ALLOCATION_STATUS_TO_UI[allocation.status] || allocation.status,
  statusCode: allocation.status,
  reason: allocation.reason,
  allocatedBy: allocation.allocatedBy ? allocation.allocatedBy.name : null,
  approvalReference: allocation.approval ? allocation.approval.reference : null,
  confirmedAt: allocation.confirmedAt,
  rejectedAt: allocation.rejectedAt,
  createdAt: allocation.createdAt,
});

const toApproval = (approval) => ({
  id: approval.reference,
  dbId: approval.id,
  title: approval.title,
  subtitle: approval.subtitle,
  requestedBy: approval.requestedByName,
  createdAt: approval.createdAt,
  status: APPROVAL_STATUS_TO_UI[approval.status] || approval.status,
  statusCode: approval.status,
  priority: approval.priority,
  summary: approval.summary || {},
  recommendationIds: approval.recommendationIds || [],
  conflictsRaised: approval.conflictsRaised,
  impact: approval.impact || [],
  optimizationId: approval.optimizationId,
  decidedBy: approval.decidedByName,
  decidedAt: approval.decidedAt,
  reason: approval.reason,
});

/* ------------------------------------------------------------------ loading */

/**
 * Loads the whole operational state.
 *
 * `options.simulationId`:
 *   · undefined / 'auto' → live data plus the active simulation overlay, if one
 *     is running (the operational picture staff are working with)
 *   · null               → live data only
 *   · a simulation id    → that snapshot plus live data
 *
 * Live tables are never mutated by a simulation: surge patients and projected
 * holds live in simulation-scoped rows (§28–29).
 */
async function loadState({ simulationId = 'auto' } = {}) {
  let activeSimulationId = null;
  if (simulationId === 'auto') {
    const active = await prisma.surgeSimulation.findFirst({
      where: { active: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    activeSimulationId = active ? active.id : null;
  } else {
    activeSimulationId = simulationId;
  }

  const simulationFilter = activeSimulationId
    ? { OR: [{ simulationId: activeSimulationId }, { simulationId: null }] }
    : { simulationId: null };

  const [
    bedRows,
    doctors,
    nurses,
    equipment,
    emergencyResources,
    theatres,
    queueRows,
    backlogRows,
    patients,
    alerts,
    allocations,
    approvals,
    tasks,
    optimizationRun,
    simulation,
    rejected,
  ] = await Promise.all([
    prisma.bed.findMany({ include: { patient: true }, orderBy: { id: 'asc' } }),
    prisma.doctor.findMany({ orderBy: [{ workload: 'asc' }, { name: 'asc' }] }),
    prisma.nurse.findMany({ orderBy: { id: 'asc' } }),
    prisma.equipment.findMany({ include: { units: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
    prisma.emergencyResource.findMany({ orderBy: { id: 'asc' } }),
    prisma.operatingTheatre.findMany({ include: { schedule: true }, orderBy: { id: 'asc' } }),
    prisma.patientQueue.findMany({
      where: { status: { in: ['WAITING', 'ALLOCATION_PROPOSED'] }, patient: simulationFilter },
      include: { patient: { include: { assignedDoctor: true, assignedNurse: true } } },
      orderBy: [{ waitingSince: 'asc' }],
    }),
    prisma.otSchedule.findMany({
      where: { status: 'SCHEDULED', theatre: { status: 'AVAILABLE' } },
      include: { patient: true },
    }),
    prisma.patient.findMany({
      where: { ...simulationFilter, queueEntry: { is: null } },
      include: {
        assignedDoctor: true,
        assignedNurse: true,
        occupiedBed: true,
        queueEntry: true,
      },
      orderBy: { patientNumber: 'asc' },
    }),
    prisma.alert.findMany({ include: { patient: true }, orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }] }),
    prisma.allocation.findMany({
      include: { patient: true, allocatedBy: true, approval: true },
      orderBy: { createdAt: 'desc' },
      take: 60,
    }),
    prisma.approval.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.clinicalTask.findMany({ orderBy: { reference: 'asc' } }),
    prisma.optimizationRun.findFirst({
      orderBy: { generatedAt: 'desc' },
      include: { recommendations: true },
    }),
    prisma.surgeSimulation.findFirst({ where: { active: true }, orderBy: { createdAt: 'desc' } }),
    prisma.optimizationRecommendation.findMany({ where: { status: 'REJECTED' }, orderBy: { rejectedAt: 'desc' }, take: 20 }),
  ]);

  const liveBacklog = backlogRows.map(toOtBacklogRow);

  /* Queued patients that need a theatre but have no slot are part of the backlog,
     so the OT picture is always derived from patients, not a fixed list. */
  const queuedNeedingOt = queueRows
    .filter((entry) => entry.patient.needsOt && !entry.patient.assignedOtId)
    .map((entry) => ({
      id: `OTS-${entry.patient.patientNumber}`,
      reference: `OTS-${entry.patient.patientNumber}`,
      patientId: entry.patientId,
      patientNumber: entry.patient.patientNumber,
      patientLabel: entry.patient.patientNumber,
      procedure: 'Emergency surgical requirement recorded',
      priority: entry.priority,
      surgeon: entry.patient.assignedDoctor ? entry.patient.assignedDoctor.name : 'Awaiting allocation',
      status: 'SCHEDULED',
      source: 'queue',
      theatreId: null,
    }));

  const shift = currentShift();

  /* ---------------------------------------------- simulation projection (§28)
     A surge snapshot never mutates the live tables: the projected holds that
     belong to the simulation are applied to the *returned* units only. */
  let bedUnits = bedRows.map(toBedUnit);
  let emergencyResourceRows = emergencyResources;
  let doctorRows = doctors;
  if (simulation && simulation.changes) {
    const projection = simulation.changes.projection || {};
    const holds = new Map((projection.bedHolds || []).map((hold) => [hold.bedId, hold.heldFor]));
    if (holds.size) {
      bedUnits = bedUnits.map((unit) =>
        holds.has(unit.id) ? { ...unit, status: 'Reserved', heldFor: holds.get(unit.id) } : unit,
      );
    }
    const adjustments = new Map(
      (projection.emergencyResourceAdjustments || []).map((entry) => [entry.id, entry]),
    );
    if (adjustments.size) {
      emergencyResourceRows = emergencyResources.map((resource) => {
        const adjustment = adjustments.get(resource.id);
        if (!adjustment) return resource;
        return {
          ...resource,
          inUse: Math.min(resource.total, resource.inUse + (adjustment.inUseDelta || 0)),
          heldFor: adjustment.heldFor || resource.heldFor,
        };
      });
    }
    const standby = new Map((projection.staffStandby || []).map((entry) => [entry.id, entry]));
    if (standby.size) {
      doctorRows = doctors.map((doctor) =>
        standby.has(doctor.id)
          ? { ...doctor, currentAssignment: standby.get(doctor.id).currentAssignment }
          : doctor,
      );
    }
  }

  const configuredBeds = bedRows.length;

  return {
    meta: {
      facility: 'MediCore General Hospital',
      configuredBeds,
      wards: Object.entries(WARD_LABELS).map(([id, label]) => ({ id, name: label.name, short: label.short })),
      shift: { id: shift.id, label: shift.label },
      source: activeSimulationId ? 'simulation' : 'live',
      generatedAt: new Date(),
    },
    bedUnits,
    doctors: doctorRows.map(toDoctor),
    nurses: nurses.map(toNurse),
    equipment: equipment.map(toEquipment),
    emergencyResources: emergencyResourceRows.map(toEmergencyResource),
    otRooms: theatres.map(toTheatre),
    otBacklog: [...liveBacklog, ...queuedNeedingOt],
    queue: queueRows.map(toQueueEntry),
    patients: patients.map(toPatient),
    alerts: alerts.map(toAlert),
    allocations: allocations.map(toAllocation),
    approvals: approvals.map(toApproval),
    clinicalTasks: tasks.reduce((accumulator, task) => {
      accumulator[task.reference] = {
        id: task.reference,
        dbId: task.id,
        title: task.title,
        detail: task.detail,
        category: task.category,
        priority: task.priority,
        dueTime: task.dueTime,
        department: task.department,
        patientNumber: task.patientNumber,
        assignedDoctorId: task.assignedDoctorId,
        assignedNurseId: task.assignedNurseId,
        status: task.status,
        note: task.note,
        completedAt: task.completedAt,
        completedBy: task.completedBy,
      };
      return accumulator;
    }, {}),
    optimization: optimizationRun ? toOptimizationState(optimizationRun) : null,
    rejectedRecommendations: rejected.map((entry) => ({
      id: entry.reference,
      reason: entry.rejectedReason,
      by: entry.rejectedBy,
      at: entry.rejectedAt,
    })),
    surge: {
      active: Boolean(simulation),
      processed: Boolean(simulation),
      id: simulation ? simulation.id : null,
      reference: simulation ? simulation.reference : null,
      status: simulation ? simulation.status : 'NORMAL',
      scenario: simulation ? simulation.scenario : null,
      patientCount: simulation ? simulation.patientCount : 0,
      startedAt: simulation ? simulation.createdAt : null,
      before: simulation ? simulation.before : null,
      after: simulation ? simulation.after : null,
      changes: simulation ? simulation.changes : null,
    },
    escalation: {
      icuStepDownBays: 0,
      emergencyOverflowBays: 0,
      transferReviews: [],
      secondaryResusPoint: false,
      electiveDeferralOffered: null,
    },
    lastUpdated: new Date().toISOString(),
  };
}

const toOptimizationState = (run) => ({
  id: run.reference,
  dbId: run.id,
  generatedAt: run.generatedAt,
  requestedBy: run.requestedByName,
  status: run.status,
  impacts: run.impact,
  impact: run.impact,
  conflicts: run.conflicts,
  pressure: run.pressure,
  analysisRows: run.analysisRows,
  recommendations: run.recommendations.map((recommendation) => ({
    id: recommendation.reference,
    dbId: recommendation.id,
    resource: recommendation.resource,
    resourceCode: recommendation.resourceCode,
    action: recommendation.action,
    title: recommendation.title,
    summary: recommendation.summary,
    detail: recommendation.detail,
    highlight: recommendation.highlight,
    quantity: recommendation.quantity,
    requiresApproval: recommendation.requiresApproval,
    reason: recommendation.reason,
    score: recommendation.score,
    options: recommendation.options,
    status: recommendation.status,
    rejectedReason: recommendation.rejectedReason,
    rejectedBy: recommendation.rejectedBy,
  })),
});

module.exports = {
  loadState,
  toBedUnit,
  toDoctor,
  toNurse,
  toEquipment,
  toEmergencyResource,
  toTheatre,
  toQueueEntry,
  toPatient,
  toAlert,
  toAllocation,
  toApproval,
  toOptimizationState,
  BED_STATUS_TO_UI,
  THEATRE_STATUS_TO_UI,
  QUEUE_STATUS_TO_UI,
  ALERT_STATUS_TO_UI,
  APPROVAL_STATUS_TO_UI,
  ALLOCATION_STATUS_TO_UI,
};
