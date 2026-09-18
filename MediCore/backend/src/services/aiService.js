/**
 * HE-02 AI service — the bridge between the hospital database and the models.
 *
 *   PostgreSQL → snapshot → Python AI service → persisted run + predictions
 *                                          ↘ socket events + API payloads
 *
 * Rules this module follows:
 *   · it never applies anything. The optimizer's plan is advisory and rides the
 *     existing recommendation → approval → transaction workflow;
 *   · it never invents data. The snapshot is read from the same repository and
 *     metrics the dashboards use, so a number shown on screen and the number a
 *     model scored are the same number;
 *   · it never hides a failure. When the model service is unreachable, callers
 *     receive `null` and answer with an explicitly labelled fallback.
 */

const { prisma } = require('../config/database');
const { loadState } = require('../repositories/hospitalStateRepository');
const { calculateHospitalMetrics, buildSnapshot: buildOperationalSnapshot } = require('./metricsService');
const { detectConflicts } = require('../optimization/constraintEngine');
const simulationService = require('./simulationService');
const { currentShift } = require('../utils/time');
const { randomRef } = require('../utils/ids');
const audit = require('./auditService');
const aiClient = require('../ai/aiClient');
const { emit, room } = require('../socket/bus');
const { AI_EVENTS, AI_ROOMS, AI_CLINICAL_ROOMS } = require('../socket/aiEvents');

/* Rooms that may see hospital-wide predictions. */
const PREDICTION_ROOMS = [room.role('command_center'), room.role('resource_coordinator')];

/* ------------------------------------------------------------------ snapshot */

/**
 * Builds the snapshot the models consume, from live rows only.
 * Every field is either read from the database or computed from it.
 */
async function buildSnapshot({ state } = {}) {
  const resolved = state || (await loadState({ simulationId: 'auto' }));
  const metrics = calculateHospitalMetrics(resolved);
  const operational = buildOperationalSnapshot(resolved, currentShift());

  const bedUnits = Object.values(resolved.bedUnits || {});
  const unitKind = (bed) => (bed.wardId === 'icu' ? 'icu' : bed.wardId === 'emergency' ? 'emergency' : bed.wardId === 'maternity' ? 'maternity' : 'general');

  const doctors = Object.values(resolved.doctors || {});
  const nurses = Object.values(resolved.nurses || {});
  const queueEntries = Object.values(resolved.queue || {});
  const patients = Object.values(resolved.patients || {});

  const hourAgo = Date.now() - 60 * 60 * 1000;
  const arrivalsIn = (minutes) =>
    queueEntries.filter((entry) => {
      const registered = entry.registeredAt || entry.createdAt;
      return registered && new Date(registered).getTime() >= Date.now() - minutes * 60 * 1000;
    }).length;

  /* Arrival flow: registrations logged by the arrival table are the primary
     source; queue rows fill the very recent window before the log catches up. */
  const arrivalCounts = await prisma.arrivalLog
    .findMany({ where: { arrivedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }, select: { arrivedAt: true } })
    .then((rows) => rows.map((row) => row.arrivedAt.getTime()))
    .catch(() => []);

  const arrivalsWithin = (minutes) =>
    arrivalCounts.filter((at) => at >= Date.now() - minutes * 60 * 1000).length;

  /* Beds that were released in the last hour: a bed becomes available exactly
     when its occupant is discharged or moved. `availableFrom` is that moment. */
  const dischargedLastHour = await prisma.bed
    .count({ where: { availableFrom: { gte: new Date(hourAgo) } } })
    .catch(() => 0);

  const windowCount = (minutes) => Math.max(arrivalsWithin(minutes), minutes <= 60 ? arrivalsIn(minutes) : 0);

  const staff = metrics.doctors;
  const nurseStaff = metrics.nurses;
  const equipmentCategories = (metrics.equipment.categories || []).map((category) => ({
    categoryId: category.id,
    name: category.name,
    kind: category.kind,
    total: category.total,
    inUse: category.inUse,
    reserved: category.reserved,
    available: category.available ?? Math.max(0, category.total - category.inUse - category.reserved),
  }));
  const ventilatorRow = equipmentCategories.find((category) => category.categoryId === 'ventilators') || { total: 0, inUse: 0, available: 0, reserved: 0 };
  const monitorRow = equipmentCategories.find((category) => category.categoryId === 'monitors') || { total: 0, inUse: 0, available: 0, reserved: 0 };

  const equipmentTotals = equipmentCategories.reduce(
    (totals, category) => ({
      total: totals.total + category.total,
      inUse: totals.inUse + category.inUse,
      reserved: totals.reserved + category.reserved,
      available: totals.available + category.available,
    }),
    { total: 0, inUse: 0, reserved: 0, available: 0 },
  );

  return {
    generatedAt: new Date().toISOString(),
    facility: resolved.meta.facility,
    shift: resolved.meta.shift || { id: 'MORNING', label: currentShift() },
    beds: {
      total: metrics.beds.total,
      occupied: metrics.beds.occupied,
      reserved: metrics.beds.reserved,
      available: metrics.beds.available,
      cleaning: metrics.beds.cleaning,
      maintenance: metrics.beds.maintenance,
      icuTotal: metrics.beds.icu.total,
      icuOccupied: metrics.beds.icu.occupied,
      icuAvailable: metrics.beds.icu.available,
      escalation: metrics.beds.escalation,
    },
    queue: {
      waiting: metrics.queue.total,
      critical: metrics.queue.critical,
      high: metrics.queue.high,
      medium: metrics.queue.medium,
      low: metrics.queue.low,
      averageWaitMinutes: metrics.queue.averageWait,
      longestWaitMinutes: metrics.queue.longestWait,
      icuRequests: metrics.queue.icuRequests,
      ventilatorRequests: metrics.queue.ventilatorRequests,
      otRequests: metrics.queue.otRequests,
    },
    staff: {
      doctorsOnDuty: staff.onDuty,
      doctorsAvailable: staff.available,
      doctorsTotal: staff.total,
      doctorUtilisation: staff.workloadIndex,
      doctorAveragePatients: staff.averagePatients,
      nursesOnDuty: nurseStaff.onDuty,
      nursesAvailable: nurseStaff.available,
      nursesTotal: nurseStaff.total,
      nurseUtilisation: nurseStaff.workloadIndex,
      nurseAveragePatients: nurseStaff.averagePatients,
    },
    equipment: {
      total: equipmentTotals.total,
      inUse: equipmentTotals.inUse,
      reserved: equipmentTotals.reserved,
      available: equipmentTotals.available,
      utilisation: equipmentTotals.total
        ? Math.round((100 * (equipmentTotals.inUse + equipmentTotals.reserved)) / equipmentTotals.total)
        : 0,
      ventilators: { total: ventilatorRow.total, inUse: ventilatorRow.inUse, available: ventilatorRow.available },
      monitors: { total: monitorRow.total, inUse: monitorRow.inUse, available: monitorRow.available },
    },
    ot: {
      total: metrics.ot.total,
      active: metrics.ot.active,
      scheduled: metrics.ot.scheduled,
      available: metrics.ot.available,
      held: metrics.ot.held,
      backlog: Object.values(resolved.otBacklog || {}).length,
      utilisation: metrics.ot.total ? Math.round((100 * metrics.ot.active) / metrics.ot.total) : 0,
    },
    emergencyResources: {
      bays: (resolved.emergencyResources || []).reduce((sum, item) => sum + (item.total || 0), 0),
      inUse: (resolved.emergencyResources || []).reduce((sum, item) => sum + (item.inUse || 0), 0),
      pressure: (resolved.emergencyResources || []).reduce(
        (worst, item) => Math.max(worst, item.total ? Math.round((100 * (item.inUse || 0)) / item.total) : 0),
        0,
      ),
    },
    arrivals: {
      last15m: windowCount(15),
      last30m: windowCount(30),
      last1h: windowCount(60),
      last3h: arrivalsWithin(180),
      last6h: arrivalsWithin(360),
      last24h: arrivalsWithin(1440),
    },
    admissions: {
      last1h: patients.filter((patient) => patient.createdAt && new Date(patient.createdAt).getTime() >= hourAgo).length,
      last3h: patients.filter((patient) => patient.createdAt && new Date(patient.createdAt).getTime() >= Date.now() - 3 * 60 * 60 * 1000).length,
      last6h: patients.filter((patient) => patient.createdAt && new Date(patient.createdAt).getTime() >= Date.now() - 6 * 60 * 60 * 1000).length,
      last24h: patients.filter((patient) => patient.createdAt && new Date(patient.createdAt).getTime() >= Date.now() - 24 * 60 * 60 * 1000).length,
    },
    discharges: { last1h: dischargedLastHour },
    surgeActive: Boolean(resolved.surge.active),

    /* Per-resource detail the workload and optimisation models score. */
    doctors: doctors.map((doctor) => ({
      id: doctor.id,
      name: doctor.name,
      specialty: doctor.specialty,
      department: doctor.department,
      dutyStatus: doctor.dutyStatus,
      availability: doctor.availability,
      load: doctor.assignedPatients || 0,
      maxOperationalLoad: doctor.maxOperationalLoad || 6,
      workload: doctor.workload,
      scheduledProcedures: doctor.scheduledProcedures || 0,
      departmentPressure: metrics.pressure.byResource
        ? (metrics.pressure.byResource.find((entry) => (entry.label || '').toLowerCase().includes('doctor')) || {}).utilisation || 0
        : 0,
    })),
    nurses: nurses.map((nurse) => ({
      id: nurse.id,
      name: nurse.name,
      department: nurse.department,
      wardId: nurse.wardId || null,
      dutyStatus: nurse.dutyStatus,
      availability: nurse.availability,
      load: nurse.assignedPatients || 0,
      maxOperationalLoad: nurse.maxOperationalLoad || 4,
      departmentPressure: metrics.nurses.workloadLimit
        ? Math.round((100 * (nurse.assignedPatients || 0)) / metrics.nurses.workloadLimit)
        : 0,
    })),
    equipmentCategories,
    wards: metrics.beds.wards,
    theatreList: Object.values(resolved.otRooms || {}).map((theatre) => ({
      id: theatre.id,
      name: theatre.name,
      kind: theatre.kind,
      status: theatre.status,
      procedure: theatre.procedure,
      start: theatre.start,
      end: theatre.end,
      nextAvailableSlot: theatre.nextAvailableSlot,
      conflict: theatre.conflict,
    })),
    bedUnits: bedUnits.map((bed) => ({
      id: bed.id,
      wardId: bed.wardId,
      ward: bed.ward,
      kind: unitKind(bed),
      status: bed.status,
      available: bed.status === 'Available',
      escalation: Boolean(bed.escalation),
      heldFor: bed.heldFor,
      features: bed.features,
    })),
    pressure: {
      band: metrics.pressure.band,
      index: metrics.pressure.index,
      resources: metrics.pressure.resources,
    },
    conflicts: detectConflicts(resolved, metrics).map((conflict) => ({
      id: conflict.id,
      resource: conflict.resource,
      severity: conflict.severity,
      detail: conflict.detail,
      metadata: conflict.metadata,
    })),
    operational,
    totals: {
      beds: metrics.beds.total,
      theatres: metrics.ot.total,
      doctors: metrics.doctors.total,
      nurses: metrics.nurses.total,
      equipment: equipmentTotals.total,
      waitingPatients: metrics.queue.total,
      emergencyResources: (resolved.emergencyResources || []).length,
    },
  };
}

/**
 * Builds the optimizer's problem definition from live state.
 * The plan it returns is a proposal: nothing is applied here.
 */
async function buildOptimisationRequest({ state } = {}) {
  const resolved = state || (await loadState({ simulationId: 'auto' }));
  const metrics = calculateHospitalMetrics(resolved);

  const waiting = Object.values(resolved.queue || {}).filter((entry) => entry.status === 'Waiting' || entry.status === 'Waiting for bed');

  const patients = waiting.map((entry) => {
    const requiresIcu = entry.requiredResource === 'ICU Bed' || entry.priority === 'Critical';
    return {
      id: entry.patientId || entry.id,
      patientNumber: entry.patientNumber || entry.id,
      clinicalPriority: entry.priority || 'Medium',
      triage: entry.triage,
      waitingMinutes: entry.waitingMinutes || 0,
      requiredWardId: requiresIcu ? 'icu' : entry.requiredResource === 'Maternity Bed' ? 'maternity' : entry.requiredResource === 'Emergency Bed' ? 'emergency' : 'general',
      requiresIcu,
      requiresVentilator: entry.requiresVentilator || entry.requiredResource === 'Ventilator',
      requiresMonitoring: requiresIcu || entry.requiredResource === 'Ventilator' || entry.requiredResource === 'Emergency Bed',
      needsOt: Boolean(entry.needsOt),
      specialty: entry.specialtyRequired || entry.department || 'Emergency Medicine',
      department: entry.department || 'Emergency',
    };
  });

  const beds = Object.values(resolved.bedUnits || {}).map((bed) => ({
        id: bed.id,
        wardId: bed.wardId,
        ward: bed.ward,
        kind: bed.wardId === 'icu' ? 'icu' : bed.wardId === 'emergency' ? 'emergency' : bed.wardId === 'maternity' ? 'maternity' : 'general',
        status: bed.status,
        available: bed.status === 'Available',
        escalation: Boolean(bed.escalation),
      }));

  const doctors = Object.values(resolved.doctors || {}).map((doctor) => ({
    id: doctor.id,
    name: doctor.name,
    department: doctor.department,
    specialty: doctor.specialty,
    dutyStatus: doctor.dutyStatus,
    availability: doctor.availability,
    load: doctor.assignedPatients || 0,
    maxOperationalLoad: doctor.maxOperationalLoad || 6,
    eligible: doctor.dutyStatus === 'ON_DUTY' && doctor.availability === 'Available',
  }));

  const nurses = Object.values(resolved.nurses || {}).map((nurse) => ({
    id: nurse.id,
    name: nurse.name,
    department: nurse.department,
    wardId: nurse.wardId || null,
    dutyStatus: nurse.dutyStatus,
    availability: nurse.availability,
    load: nurse.assignedPatients || 0,
    maxOperationalLoad: nurse.maxOperationalLoad || 4,
    eligible: nurse.dutyStatus === 'ON_DUTY' && nurse.availability === 'Available' && (nurse.assignedPatients || 0) < 5,
  }));

  const equipment = (metrics.equipment.categories || []).map((category) => ({
    categoryId: category.id,
    name: category.name,
    kind: category.kind,
    total: category.total,
    inUse: category.inUse,
    reserved: category.reserved,
    available: category.available ?? Math.max(0, category.total - category.inUse - category.reserved),
  }));

  const theatres = Object.values(resolved.otRooms || {}).map((theatre) => ({
    id: theatre.id,
    name: theatre.name,
    kind: theatre.kind,
    status: theatre.status,
    nextAvailableSlot: theatre.nextAvailableSlot,
    requiredEquipment: theatre.requiredEquipment || [],
  }));

  const emergencyResources = (resolved.emergencyResources || []).map((resource) => ({
    id: resource.id,
    name: resource.name,
    kind: resource.kind,
    total: resource.total,
    inUse: resource.inUse,
    reserved: resource.reserved,
    available: resource.available,
    status: resource.status,
  }));

  return {
    patients,
    resources: { beds, doctors, nurses, equipment, theatres, emergencyResources },
    config: {
      horizonHours: 6,
      timeLimitSeconds: 8,
      weights: { Critical: 1000, High: 300, Medium: 80, Low: 20 },
      dutyAware: true,
      requireHumanApproval: true,
    },
  };
}

/* ------------------------------------------------------------------- runs */

/** Persists an AI run and its predictions so every number stays traceable. */
async function persistRun({ kind, auth, payload, predictions, durationMs, status = 'COMPLETED' }) {
  const reference = randomRef(kind === 'SIMULATION' ? 'AIS' : 'AIR', { entropy: 6 });

  const run = await prisma.aiRun.create({
    data: {
      reference,
      kind,
      status,
      requestedBy: auth ? auth.userId || null : null,
      actorName: auth ? auth.name || null : null,
      actorRole: auth ? auth.role || null : null,
      summary: payload.summary || {},
      findings: payload.findings || [],
      payload: {
        recommendations: payload.recommendations || [],
        optimization: payload.optimization
          ? {
              status: payload.optimization.status,
              solverStatus: payload.optimization.solverStatus,
              placements: (payload.optimization.assignments || []).length,
              deferred: (payload.optimization.deferred || []).length,
            }
          : null,
        simulation: payload.simulation ? { reference: payload.simulation.reference, scenario: payload.simulation.scenario } : null,
        modelSources: payload.modelSources || {},
        requiresHumanApproval: true,
      },
      aiServiceUp: status !== 'DEGRADED',
      durationMs,
    },
  });

  if (predictions && predictions.length) {
    await prisma.aiPrediction.createMany({
      data: predictions.slice(0, 60).map((prediction) => ({
        runId: run.id,
        reference: randomRef('AIP', { entropy: 5 }),
        target: prediction.target,
        horizon: prediction.horizon || null,
        source: prediction.source || 'unknown',
        value: typeof prediction.value === 'number' ? prediction.value : null,
        valueText: typeof prediction.value === 'number' ? null : String(prediction.value ?? ''),
        modelName: prediction.modelName || prediction.model_name || 'hospital_policy_rules',
        modelVersion: prediction.modelVersion || prediction.model_version || null,
        algorithm: prediction.algorithm || null,
        probability: prediction.probability || undefined,
        context: prediction.context || {},
      })),
    });
  }

  return run;
}

/** Flattens a prediction payload into rows, preserving provenance. */
function toPredictionRows(advisory) {
  const rows = [];
  const push = (entry, target, horizon) => {
    if (!entry) return;
    rows.push({
      target,
      horizon,
      source: entry.source || 'unknown',
      value: typeof entry.value === 'number' ? entry.value : entry.label ?? null,
      modelName: entry.model_name || entry.modelName || null,
      modelVersion: entry.model_version || entry.modelVersion || null,
      algorithm: entry.algorithm || null,
      probability: entry.probabilities || undefined,
      context: {
        fallback_reason: entry.fallback_reason || null,
        interval: entry.prediction_interval || null,
      },
    });
  };

  const predictions = advisory.predictions || {};
  Object.entries(predictions.demand?.predictions || {}).forEach(([key, entry]) =>
    push(entry, `demand:${key}`, key.endsWith('2h') ? '2h' : '1h'),
  );
  Object.entries(predictions.resources?.predictions || {}).forEach(([key, entry]) =>
    push(entry, `resource:${key}`, key.endsWith('_2h') ? '2h' : '1h'),
  );
  Object.entries(predictions.patientFlow?.predictions || {}).forEach(([key, entry]) =>
    push(entry, `flow:${key}`, '6h'),
  );
  if (predictions.pressure) {
    push(
      {
        source: predictions.pressure.source,
        value: predictions.pressure.pressure,
        model_name: predictions.pressure.model?.name,
        probabilities: predictions.pressure.probabilities,
      },
      'pressure',
      '1h',
    );
  }
  if (predictions.surgeDetection) {
    push(
      {
        source: predictions.surgeDetection.model?.source,
        value: predictions.surgeDetection.severity,
        model_name: predictions.surgeDetection.model?.name,
        algorithm: 'Isolation Forest',
      },
      'surge:severity',
      'now',
    );
  }
  (predictions.doctorWorkload?.staff || []).slice(0, 10).forEach((entry) =>
    push({ source: entry.source, value: entry.predictedLoad1h, model_name: 'doctor_workload_xgboost_load_1h' }, `workload:doctor:${entry.staffId}`, '1h'),
  );
  (predictions.nurseWorkload?.staff || []).slice(0, 10).forEach((entry) =>
    push({ source: entry.source, value: entry.predictedLoad1h, model_name: 'nurse_workload_xgboost_load_1h' }, `workload:nurse:${entry.staffId}`, '1h'),
  );
  (predictions.equipmentDemand?.categories || []).forEach((entry) =>
    push(
      {
        source: entry.source,
        value: entry.predictedUnitsNeeded1h,
        model_name: 'equipment_demand_xgboost_units_needed_1h',
      },
      `equipment:${entry.categoryId}`,
      '1h',
    ),
  );

  return rows;
}

/* --------------------------------------------------------------- inference */

/**
 * Single-family inference over the live snapshot.
 *
 * These endpoints exist so a caller can ask one question ("where is the
 * pressure in an hour?") without paying for a full advisory run. Each answer
 * carries its own provenance: `model` when a trained artifact scored it,
 * `fallback` when the service degraded to hospital rules.
 */
async function prediction({ target, includeExplain = false } = {}) {
  const snapshot = await buildSnapshot();
  const call = {
    demand: aiClient.demandForecast,
    resources: aiClient.resourceForecast,
    pressure: aiClient.pressurePredict,
    surge: aiClient.surgeDetect,
    patientFlow: aiClient.patientFlow,
    equipment: aiClient.equipmentDemand,
    doctorWorkload: aiClient.doctorWorkload,
    nurseWorkload: aiClient.nurseWorkload,
  }[target];

  if (!call) {
    const error = new Error(`Unknown prediction target '${target}'`);
    error.statusCode = 400;
    error.code = 'UNKNOWN_PREDICTION_TARGET';
    throw error;
  }

  let payload;
  try {
    payload = await call({ snapshot });
  } catch (error) {
    if (error instanceof aiClient.AiUnavailableError) {
      const unavailable = new Error(
        'The AI service is currently unavailable. Live operational metrics remain available; no forecast can be produced right now.',
      );
      unavailable.statusCode = 503;
      unavailable.code = 'AI_SERVICE_UNAVAILABLE';
      throw unavailable;
    }
    throw error;
  }

  return {
    target,
    generatedAt: snapshot.generatedAt,
    snapshotDigest: {
      beds: snapshot.beds,
      queue: snapshot.queue,
      staff: snapshot.staff,
      equipment: snapshot.equipment,
      ot: snapshot.ot,
      pressure: snapshot.pressure,
    },
    prediction: payload,
    requiresHumanApproval: true,
    disclaimer:
      'Operational decision support only, projected from the current operational picture. It is not a diagnosis and it never starts, stops or changes care.',
    ...(includeExplain ? {} : {}),
  };
}

/** The model registry as the API service sees it. */
async function models() {
  try {
    const payload = await aiClient.models();
    return { ...payload, reachable: true };
  } catch (error) {
    return {
      reachable: false,
      models: [],
      error: error.message,
      note: 'The hospital continues on live operational metrics while the model service is down.',
    };
  }
}

/* ------------------------------------------------------------------ advisory */

/**
 * Runs the full advisory pass and persists it.
 * @returns {Promise<object|null>} `null` when the model service is unavailable
 */
async function advisory({ auth, includeSimulation = false, surgePatientCount = 20, persist = true } = {}) {
  const state = await loadState({ simulationId: 'auto' });
  const startedAt = Date.now();

  const [snapshot, problem] = await Promise.all([buildSnapshot({ state }), buildOptimisationRequest({ state })]);

  let payload;
  try {
    payload = await aiClient.advisory({
      snapshot,
      patients: problem.patients,
      resources: problem.resources,
      config: problem.config,
      includeSimulation,
      surgePatientCount,
    });
  } catch (error) {
    if (error instanceof aiClient.AiUnavailableError) {
      emit(AI_EVENTS.SERVICE_DEGRADED, { reason: error.message, fallback: 'deterministic hospital logic' }, { rooms: AI_ROOMS });
      audit.record({
        action: 'AI_ADVISORY_UNAVAILABLE',
        auth,
        entity: 'AiRun',
        entityId: '—',
        detail: { message: `AI advisory unavailable — ${error.message}. The command centre continues on live operational metrics.`, tone: 'alert' },
      });
      return null;
    }
    throw error;
  }

  const predictions = toPredictionRows(payload);
  const durationMs = Date.now() - startedAt;

  const run = persist
    ? await persistRun({
        kind: 'ADVISORY',
        auth,
        payload: {
          ...payload,
          modelSources: Object.fromEntries(predictions.map((prediction) => [prediction.target, prediction.source])),
        },
        predictions,
        durationMs,
      })
    : null;

  publishAdvisory({ reference: run ? run.reference : null, payload });

  audit.record({
    action: 'AI_ADVISORY_RUN',
    auth,
    entity: 'AiRun',
    entityId: run ? run.reference : '—',
    detail: {
      message: `AI advisory completed — ${payload.findings.length} finding(s), ${payload.recommendations.length} recommendation(s) awaiting human approval`,
      tone: 'info',
    },
  });

  return { ...payload, run: run ? { reference: run.reference, createdAt: run.createdAt, predictionCount: predictions.length } : null, durationMs, snapshot };
}

/** AI what-if projection. Never written to live operational rows. */
async function simulate({ auth, patientCount = 20, scenario = 'MASS_CASUALTY_INTAKE' } = {}) {
  const state = await loadState({ simulationId: 'auto' });
  const startedAt = Date.now();
  const [snapshot, problem] = await Promise.all([buildSnapshot({ state }), buildOptimisationRequest({ state })]);

  let payload;
  try {
    payload = await aiClient.simulate({
      state: {
        totalBeds: snapshot.beds.total,
        occupiedBeds: snapshot.beds.occupied,
        totalIcu: snapshot.beds.icuTotal,
        occupiedIcu: snapshot.beds.icuOccupied,
        queue: snapshot.queue.waiting,
        doctorsAvailable: snapshot.staff.doctorsAvailable,
        nursesAvailable: snapshot.staff.nursesAvailable,
        ventilatorsInUse: snapshot.equipment.ventilators.inUse,
        ventilatorsTotal: snapshot.equipment.ventilators.total,
        monitorsInUse: snapshot.equipment.monitors.inUse,
        monitorsTotal: snapshot.equipment.monitors.total,
        theatreBacklog: snapshot.ot.backlog,
        arrivalsPerHour: Math.max(1, snapshot.arrivals.last1h),
        shift: snapshot.shift,
      },
      patientCount,
      scenario,
      resources: problem.resources,
      queuePatients: problem.patients,
      config: problem.config,
    });
  } catch (error) {
    if (error instanceof aiClient.AiUnavailableError) return null;
    throw error;
  }

  const run = await persistRun({
    kind: 'SIMULATION',
    auth,
    payload,
    predictions: [
      {
        target: 'simulation:bedOccupancy',
        horizon: `${patientCount} patients`,
        source: payload.afterSurge ? 'model' : 'fallback',
        value: payload.afterSurge?.bedOccupancy ?? null,
        modelName: 'surge_simulator',
        algorithm: 'deterministic projection with model-derived disposition rates',
      },
    ],
    durationMs: Date.now() - startedAt,
  });

  emit(
    AI_EVENTS.SIMULATION_COMPLETED,
    {
      runReference: run.reference,
      reference: payload.reference,
      scenario,
      patientCount,
      before: payload.before,
      afterSurge: payload.afterSurge,
      afterOptimisation: payload.afterOptimisation,
      impacts: payload.impacts,
      note: 'Projection only — no live operational row was modified. A coordinator confirms before anything changes.',
    },
    { rooms: AI_ROOMS },
  );

  return { ...payload, run: { reference: run.reference }, snapshot };
}

/**
 * Advisory for the API layer.
 *
 * When the model service is down the caller still gets a usable, clearly
 * labelled answer built from hospital rules — never a silent guess, and never a
 * broken screen. `degraded: true` is what a client shows as "model service
 * unavailable; showing rule-based guidance".
 */
async function advisoryOrFallback({ auth, includeSimulation = false, surgePatientCount = 20 } = {}) {
  const live = await advisory({ auth, includeSimulation, surgePatientCount });
  if (live) return { ...live, degraded: false };

  const state = await loadState({ simulationId: 'auto' });
  const metrics = calculateHospitalMetrics(state);
  const conflicts = detectConflicts(state, metrics);

  return {
    degraded: true,
    reason: 'The AI model service is unreachable; this advisory was produced by hospital rules over live operational data.',
    generatedAt: new Date().toISOString(),
    run: null,
    summary: {
      headline: `Hospital pressure is ${metrics.pressure.band} (index ${metrics.pressure.index}).`,
      lines: [
        `Occupancy ${metrics.beds.occupancyPercentage}% — ${metrics.beds.available} bed(s) free, ${metrics.beds.icu.available} ICU bed(s) free.`,
        `${metrics.queue.total} patient(s) waiting; ${metrics.queue.critical} critical.`,
        `${metrics.doctors.onDuty}/${metrics.doctors.total} doctors and ${metrics.nurses.onDuty}/${metrics.nurses.total} nurses on duty.`,
      ],
      method: 'hospital policy rules over live operational data (model service unavailable)',
    },
    findings: conflicts.map((conflict) => ({
      id: conflict.id,
      resource: conflict.resource,
      severity: conflict.severity,
      detail: conflict.detail,
    })),
    recommendations: [],
    optimization: null,
    requiresHumanApproval: true,
    disclaimer:
      'Operational decision support only. This is a recommendation for review — it has no effect until an authorised staff member approves it.',
  };
}

/** Simulation for the API layer, with the same degradation contract. */
async function simulateOrFallback({ auth, patientCount = 20 } = {}) {
  const live = await simulate({ auth, patientCount });
  if (live) return { ...live, degraded: false };

  const projected = await simulationService.run({ auth, patientCount, source: 'rule-based projection (AI service unavailable)' });
  return {
    degraded: true,
    reason: 'The AI model service is unreachable; this projection was computed by the hospital simulation service instead.',
    reference: projected.id || projected.reference,
    scenario: 'SURGE_INTAKE',
    patientCount,
    projected,
    note: 'Projection only — no live operational row was modified.',
  };
}

/** The latest advisory as persisted, for clients that reconnect. */
async function latestAdvisory() {
  const stored = await latest();
  if (!stored) {
    return { available: false, reason: 'No advisory has been run yet.' };
  }
  const predictions = await prisma.aiPrediction.findMany({
    where: { runId: (await prisma.aiRun.findUnique({ where: { reference: stored.reference } })).id },
    orderBy: { target: 'asc' },
  });
  return {
    available: true,
    reference: stored.reference,
    createdAt: stored.createdAt,
    summary: stored.summary,
    findings: stored.findings,
    recommendations: stored.recommendations,
    optimization: stored.optimization,
    predictions: predictions.map((row) => ({
      target: row.target,
      horizon: row.horizon,
      source: row.source,
      value: row.value,
      valueText: row.valueText,
      model: row.modelName,
      version: row.modelVersion,
    })),
    requiresHumanApproval: true,
  };
}

/** One stored run and everything inside it. */
async function runDetail(reference) {
  const detail = await predictionsFor(reference);
  if (!detail) {
    const error = new Error(`No AI run with reference '${reference}'`);
    error.statusCode = 404;
    error.code = 'AI_RUN_NOT_FOUND';
    throw error;
  }
  return {
    run: {
      reference: detail.run.reference,
      kind: detail.run.kind,
      status: detail.run.status,
      requestedBy: detail.run.requestedBy,
      actorName: detail.run.actorName,
      actorRole: detail.run.actorRole,
      aiServiceUp: detail.run.aiServiceUp,
      durationMs: detail.run.durationMs,
      createdAt: detail.run.createdAt,
    },
    summary: detail.run.summary,
    findings: detail.run.findings,
    payload: detail.run.payload,
    predictions: detail.predictions.map((row) => ({
      target: row.target,
      horizon: row.horizon,
      source: row.source,
      value: row.value,
      valueText: row.valueText,
      model: row.modelName,
      version: row.modelVersion,
      algorithm: row.algorithm,
      createdAt: row.createdAt,
    })),
  };
}

/* ------------------------------------------------------------------- cache */

/**
 * A short-lived cache of the last advisory, for the aggregated dashboard.
 *
 * The dashboard must never wait on the model service — an operations screen
 * that blocks on an ML process is worse than one without a forecast. So the
 * cached advisory is returned immediately and, when it is stale, a refresh is
 * started in the background. `available: false` means the AI layer is down and
 * the client should show live metrics only.
 */
const advisoryCache = { data: null, at: 0, refreshing: false, lastError: null };

async function cachedAdvisory({ maxAgeMs = 120000, refresh = true } = {}) {
  const ageMs = Date.now() - advisoryCache.at;
  const fresh = advisoryCache.data && ageMs <= maxAgeMs;

  if (!fresh && refresh && !advisoryCache.refreshing) {
    advisoryCache.refreshing = true;
    advisory({ persist: true })
      .then((result) => {
        if (result) {
          advisoryCache.data = {
            available: true,
            reference: result.run ? result.run.reference : null,
            generatedAt: result.generatedAt,
            summary: result.summary,
            pressure: result.predictions.pressure,
            demand: result.predictions.demand.summary,
            surgeDetection: result.predictions.surgeDetection,
            patientFlow: result.predictions.patientFlow.projection,
            workload: {
              doctors: result.predictions.doctorWorkload.summary,
              nurses: result.predictions.nurseWorkload.summary,
            },
            equipment: result.predictions.equipmentDemand.summary,
            findings: result.findings,
            optimization: result.optimization,
            recommendations: result.recommendations.map((recommendation) => ({
              id: recommendation.id,
              type: recommendation.type,
              title: recommendation.title,
              priority: recommendation.priority,
              status: recommendation.status,
            })),
            sources: {
              pressure: result.predictions.pressure.source,
              demand: result.predictions.demand.sources,
              surge: result.predictions.surgeDetection.model?.source,
            },
            requiresHumanApproval: true,
          };
          advisoryCache.at = Date.now();
          advisoryCache.lastError = null;
        } else {
          advisoryCache.data = { available: false, generatedAt: new Date().toISOString(), reason: 'the AI service is unreachable' };
          advisoryCache.at = Date.now();
        }
      })
      .catch((error) => {
        advisoryCache.lastError = error.message;
      })
      .finally(() => {
        advisoryCache.refreshing = false;
      });
  }

  if (advisoryCache.data) {
    return { ...advisoryCache.data, ageMs: Date.now() - advisoryCache.at, refreshing: advisoryCache.refreshing };
  }

  /* Nothing cached yet (a fresh process): fall back to the last persisted run so
     a restart does not blank the command centre. */
  const stored = await latest().catch(() => null);
  if (stored) {
    return {
      available: true,
      fromHistory: true,
      reference: stored.reference,
      generatedAt: stored.createdAt,
      summary: stored.summary,
      findings: stored.findings,
      recommendations: stored.recommendations,
      optimization: stored.optimization,
      refreshing: advisoryCache.refreshing,
      note: 'Most recent stored advisory — the models are being re-queried in the background.',
    };
  }

  return {
    available: null,
    refreshing: advisoryCache.refreshing,
    reason: advisoryCache.lastError || 'the first advisory is still being computed',
  };
}

function invalidateAdvisoryCache() {
  advisoryCache.at = 0;
}

/* --------------------------------------------------------------- publishing */

/** Emits the advisory over the socket, room by room. */
function publishAdvisory({ reference, payload }) {
  const base = { runReference: reference, generatedAt: payload.generatedAt, requiresHumanApproval: true };

  const pressure = payload.predictions?.pressure;
  const demand = payload.predictions?.demand;
  const surge = payload.predictions?.surgeDetection;

  if (pressure) {
    emit(
      AI_EVENTS.PREDICTION_UPDATED,
      {
        ...base,
        pressure: pressure.pressure,
        pressureIndex: pressure.pressureIndex,
        projectedBand1h: pressure.projections?.projectedBand1h,
        mainDriver: pressure.explanation?.main_driver,
        demand: demand?.summary,
        sources: { pressure: pressure.source, demand: demand?.sources },
      },
      { rooms: PREDICTION_ROOMS },
    );
  }

  if (surge && surge.anomaly_detected) {
    emit(
      AI_EVENTS.SURGE_DETECTED,
      {
        ...base,
        severity: surge.severity,
        detectorView: surge.modelSeverity,
        anomalyScore: surge.anomaly_score,
        trigger: surge.trigger,
        source: surge.model?.source,
        clinicalNote: 'Clinical teams continue regardless of this signal — it never delays emergency care.',
      },
      { rooms: AI_ROOMS },
    );
  }

  if (pressure && payload.findings?.length) {
    emit(
      AI_EVENTS.RESOURCE_PRESSURE_CHANGED,
      {
        ...base,
        pressure: pressure.pressure,
        pressureIndex: pressure.pressureIndex,
        findings: payload.findings.slice(0, 6).map((finding) => ({
          resource: finding.resource,
          label: finding.label,
          severity: finding.severity,
          gap: finding.gap,
          detail: finding.detail,
          source: finding.source,
        })),
      },
      { rooms: PREDICTION_ROOMS },
    );
  }

  if (payload.optimization?.status === 'NO_FEASIBLE_ALLOCATION') {
    emit(
      AI_EVENTS.RESOURCE_CONFLICT_DETECTED,
      {
        ...base,
        status: payload.optimization.status,
        blockingResources: payload.optimization.blockingResources || [],
        escalationOptions: payload.optimization.escalationOptions || [],
      },
      { rooms: AI_ROOMS },
    );
  } else if (payload.optimization) {
    emit(
      AI_EVENTS.OPTIMIZATION_COMPLETED,
      {
        ...base,
        status: payload.optimization.status,
        solverStatus: payload.optimization.solverStatus,
        placements: (payload.optimization.assignments || []).length,
        deferred: (payload.optimization.deferred || []).length,
        utilisation: payload.optimization.utilisation,
      },
      { rooms: PREDICTION_ROOMS },
    );
  }

  if (payload.recommendations?.length) {
    emit(
      AI_EVENTS.RECOMMENDATION_CREATED,
      {
        ...base,
        count: payload.recommendations.length,
        recommendations: payload.recommendations.slice(0, 6).map((recommendation) => ({
          id: recommendation.id,
          type: recommendation.type,
          title: recommendation.title,
          priority: recommendation.priority,
          status: recommendation.status,
        })),
      },
      { rooms: AI_ROOMS },
    );
  }

  /* One summary event for the command centre, so a client that only cares about
     the advisory does not have to stitch the individual events together. */
  return emit(
    AI_EVENTS.ADVISORY_SUMMARY,
    { ...base, summary: payload.summary, findings: payload.findings, recommendations: payload.recommendations },
    { rooms: AI_ROOMS },
  );
}

/** What the command centre shows when it asks for the latest AI picture. */
async function latest() {
  const run = await prisma.aiRun.findFirst({ where: { kind: 'ADVISORY' }, orderBy: { createdAt: 'desc' } });
  if (!run) return null;
  return {
    reference: run.reference,
    createdAt: run.createdAt,
    summary: run.summary,
    findings: run.payload?.findings || [],
    recommendations: run.payload?.recommendations || [],
    optimization: run.payload?.optimization || null,
    durationMs: run.durationMs,
  };
}

async function history({ limit = 10 } = {}) {
  const runs = await prisma.aiRun.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(limit, 50) });
  return runs.map((run) => ({
    reference: run.reference,
    kind: run.kind,
    status: run.status,
    createdAt: run.createdAt,
    durationMs: run.durationMs,
    summary: run.summary,
  }));
}

/** The predictions behind one run, with their provenance. */
async function predictionsFor(reference) {
  const run = await prisma.aiRun.findUnique({ where: { reference } });
  if (!run) return null;
  const predictions = await prisma.aiPrediction.findMany({ where: { runId: run.id }, orderBy: { target: 'asc' } });
  return { run, predictions };
}

/** Model + service status for the health endpoint. */
async function serviceStatus() {
  const client = aiClient.state();
  if (!client.enabled || client.circuitBreakerOpen) {
    return { enabled: client.enabled, reachable: false, client, note: 'Hospital logic continues without models.' };
  }
  try {
    const detail = await aiClient.health();
    return {
      enabled: true,
      reachable: true,
      client: aiClient.state(),
      service: detail.service,
      version: detail.version,
      models: detail.models,
      modelDetail: detail.model_detail,
      policy: detail.policy,
      optimizer: detail.optimizer,
      featureVersion: detail.feature_version,
      modelsSummary: detail.models_summary,
      lastModelUpdate: detail.last_model_update,
      history: detail.history,
      syntheticWarning: detail.synthetic_warning,
      disclaimer: detail.disclaimer,
    };
  } catch (error) {
    return { enabled: true, reachable: false, client: aiClient.state(), error: error.message, note: 'Hospital logic continues without models.' };
  }
}

module.exports = {
  buildSnapshot,
  buildOptimisationRequest,
  prediction,
  models,
  advisoryOrFallback,
  simulateOrFallback,
  latestAdvisory,
  runDetail,
  cachedAdvisory,
  invalidateAdvisoryCache,
  buildOptimisationRequest,
  advisory,
  simulate,
  latest,
  history,
  predictionsFor,
  serviceStatus,
  persistRun,
  toPredictionRows,
  publishAdvisory,
  PREDICTION_ROOMS,
  AI_ROOMS,
  AI_CLINICAL_ROOMS,
  AI_EVENTS,
};
