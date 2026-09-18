/**
 * Dashboard service (§19, §35).
 *
 * One aggregated payload for a whole dashboard — the client never has to make
 * fifteen calls. The payload is role-scoped: a doctor receives their own
 * patients only, a nurse receives their assigned patients only, and neither
 * receives another clinician's patient detail (§47).
 */

const { loadState } = require('../repositories/hospitalStateRepository');
const {
  calculateHospitalMetrics,
  calculateResourcePressure,
  buildSnapshot,
} = require('./metricsService');
const { detectConflicts } = require('../optimization/constraintEngine');
const { list: listAudit } = require('./auditService');
const { currentShift } = require('../utils/time');
const aiService = require('./aiService');

/** Activity feed derived from the audit trail — real recorded actions. */
async function buildActivity(limit = 12) {
  const entries = await listAudit({ limit });
  return entries.map((entry) => ({
    id: entry.id,
    message: entry.detail && entry.detail.message ? entry.detail.message : `${entry.action}${entry.entityId ? ` — ${entry.entityId}` : ''}`,
    type: entry.detail && entry.detail.tone ? entry.detail.tone : 'info',
    actor: entry.actor,
    timestamp: entry.timestamp,
  }));
}

const wardOf = (patient) => (patient.assignedBed ? patient.assignedBed.ward : patient.department || 'Emergency');
const bedOf = (patient) => (patient.assignedBed ? patient.assignedBed.id : null);

/** Clinical record shape the doctor / nurse screens render. */
function toClinicalPatient(patient, tasks = []) {
  return {
    id: patient.patientNumber,
    patientNumber: patient.patientNumber,
    dbId: patient.id,
    name: patient.name,
    age: patient.age,
    sex: patient.sex,
    ward: wardOf(patient),
    bed: bedOf(patient),
    priority: patient.priority,
    triage: patient.triage,
    diagnosis: patient.diagnosis || patient.notes || 'Under assessment',
    status: patient.status,
    plan: patient.plan || 'Operational monitoring plan recorded by the treating team.',
    admitted: patient.createdAt,
    requiredResource: patient.requiredResource,
    secondaryResource: patient.secondaryResource,
    queueStatus: patient.queueStatus,
    waitingMinutes: patient.waitingMinutes,
    specialtyRequired: patient.specialtyRequired,
    requiresVentilator: patient.requiresVentilator,
    needsOt: patient.needsOt,
    vitals: patient.vitals,
    assignedDoctors: [patient.assignedDoctorId].filter(Boolean),
    assignedNurses: [patient.assignedNurseId].filter(Boolean),
    assignedDoctor: patient.assignedDoctor,
    assignedNurse: patient.assignedNurse,
    tasks: tasks.filter((task) => task.patientNumber === patient.patientNumber && task.status !== 'Completed').map((task) => task.title),
    isSimulated: patient.isSimulated,
  };
}

/** Restricts the operational picture to what the signed-in role owns. */
function scopeForRole(state, auth) {
  const isDoctor = auth.role === 'doctor';
  const isNurse = auth.role === 'nurse';

  const visiblePatients = (patient) => {
    if (auth.role === 'command_center' || auth.role === 'resource_coordinator') return true;
    if (isDoctor) return patient.assignedDoctorId === auth.staffRef;
    if (isNurse) return patient.assignedNurseId === auth.staffRef;
    return false;
  };

  const patients = state.patients.filter(visiblePatients);
  const queue =
    auth.role === 'command_center' || auth.role === 'resource_coordinator'
      ? state.queue
      : state.queue.filter((entry) => {
          if (isDoctor) return entry.assignedDoctorId === auth.staffRef;
          if (isNurse) return entry.assignedNurseId === auth.staffRef;
          return false;
        });

  const clinicalTasks = Object.values(state.clinicalTasks).filter((task) => {
    if (auth.role === 'command_center' || auth.role === 'resource_coordinator') return true;
    if (isDoctor) return task.assignedDoctorId === auth.staffRef;
    if (isNurse) return task.assignedNurseId === auth.staffRef;
    return false;
  });

  return {
    patients,
    queue,
    clinicalTasks: clinicalTasks.reduce((accumulator, task) => {
      accumulator[task.id] = { ...task, patientId: task.patientNumber };
      return accumulator;
    }, {}),
  };
}

/**
 * `GET /api/dashboard/overview`
 * Returns the aggregated operational state, the computed metrics, the resource
 * pressure model, the open conflicts and the role-scoped collections.
 */
async function buildOverview({ auth, simulationId = 'auto', refreshAlerts = true } = {}) {
  const state = await loadState({ simulationId });
  const metrics = calculateHospitalMetrics(state);
  const conflicts = detectConflicts(state, metrics);
  const pressure = calculateResourcePressure({ ...state, conflicts });
  const scoped = scopeForRole(state, auth || { role: 'command_center' });
  const snapshot = buildSnapshot({ ...state, conflicts }, state.surge.active ? 'Surge intake' : 'Live hospital state');

  return {
    ...snapshot,
    pressure,
    conflicts,
    metrics: { ...metrics, conflicts, surgeActive: Boolean(state.surge.active) },
    label: snapshot.label,

    /* collections the dashboards render */
    beds: state.bedUnits,
    bedUnits: state.bedUnits,
    doctors: state.doctors,
    nurses: state.nurses,
    equipment: state.equipment,
    emergencyResources: state.emergencyResources,
    otRooms: state.otRooms,
    otBacklog: state.otBacklog,
    patients: scoped.patients,
    myPatients: scoped.patients.filter((patient) => patient.assignedDoctorId === (auth || {}).staffRef || patient.assignedNurseId === (auth || {}).staffRef),
    queue: scoped.queue,
    clinicalTasks: scoped.clinicalTasks,
    alerts: state.alerts,
    approvals: state.approvals,
    allocations: state.allocations,
    optimization: state.optimization,
    rejectedRecommendations: state.rejectedRecommendations,
    surge: state.surge,
    escalation: { ...state.escalation, shift: currentShift() },
    meta: { ...state.meta, generatedAt: new Date(), scope: auth ? auth.role : 'public' },
    activity: await buildActivity(refreshAlerts ? 12 : 12),

    /* HE-02 AI context. Served from cache so the dashboard never waits on the
       model service; `available:false` means the AI layer is down and the
       dashboards show live metrics only. Predictions are advisory and are
       labelled as projected wherever they are displayed. */
    ai: await aiService.cachedAdvisory({}),

    generatedAt: new Date(),
  };
}

/** Compact KPIs used by the header and by health checks. */
function buildKpis(metrics) {
  return {
    bedsTotal: metrics.beds.total,
    bedsAvailable: metrics.beds.available,
    bedsOccupancy: metrics.beds.occupancyPercentage,
    icuOccupancy: metrics.beds.icu.occupancyPercentage,
    icuAvailable: metrics.beds.icu.available,
    queueTotal: metrics.queue.total,
    queueCritical: metrics.queue.critical,
    doctorsAvailable: metrics.doctors.available,
    doctorsOnDuty: metrics.doctors.onDuty,
    nursesAvailable: metrics.nurses.available,
    nursesAtConstraint: metrics.nurses.atConstraint,
    equipmentUtilisation: metrics.equipment.utilisation,
    ventilatorsAvailable: metrics.equipment.ventilators ? metrics.equipment.ventilators.available : 0,
    otAvailable: metrics.ot.available,
    pressure: metrics.pressure.overall,
    pressureBand: metrics.pressure.band,
    openConflicts: metrics.conflicts.length,
    activeAlerts: metrics.activeAlerts.length,
    pendingApprovals: metrics.pendingApprovals.length,
    surgeActive: metrics.surgeActive,
  };
}

module.exports = { buildOverview, buildKpis, buildActivity, scopeForRole, toClinicalPatient };
