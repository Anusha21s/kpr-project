/**
 * Controllers (§15).
 *
 * Controllers stay thin: they read the validated request, call one service and
 * choose the response envelope. All operational logic lives in the services.
 */

const authService = require('../services/authService');
const dashboardService = require('../services/dashboardService');
const patientService = require('../services/patientService');
const queueService = require('../services/queueService');
const bedService = require('../services/bedService');
const staffService = require('../services/staffService');
const equipmentService = require('../services/equipmentService');
const emergencyResourceService = require('../services/emergencyResourceService');
const otService = require('../services/otService');
const simulationService = require('../services/simulationService');
const optimizationService = require('../services/optimizationService');
const allocationService = require('../services/allocationService');
const alertService = require('../services/alertService');
const notificationService = require('../services/notificationService');
const clinicalTaskService = require('../services/clinicalTaskService');
const auditService = require('../services/auditService');
const { buildKpis } = require('../services/dashboardService');
const { calculateHospitalMetrics, calculateResourcePressure } = require('../services/metricsService');
const { loadState } = require('../repositories/hospitalStateRepository');
const { checkDatabase } = require('../config/database');
const aiService = require('../services/aiService');
const { ok, mutation } = require('../utils/http');

/**
 * Wraps an async controller so a rejected promise reaches the central error
 * handler instead of leaving the request hanging (Express 4 does not forward
 * async rejections by itself).
 */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const query = (req) => req.validatedQuery || req.query || {};
const body = (req) => req.body || {};

/* ------------------------------------------------------------------ auth */
const auth = {
  login: async (req, res) => {
    const session = await authService.login({ ...body(req), ip: req.ip });
    return ok(res, session);
  },
  logout: async (req, res) => ok(res, { ...(await authService.logout({ auth: req.auth, ip: req.ip })) }),
  me: async (req, res) => ok(res, await authService.me(req.auth)),
};

/* ------------------------------------------------------------- dashboard */
const dashboard = {
  overview: async (req, res) => {
    const payload = await dashboardService.buildOverview({ auth: req.auth, simulationId: query(req).simulationId || 'auto' });
    return ok(res, payload);
  },
  kpis: async (req, res) => {
    const state = await loadState({ simulationId: 'auto' });
    const metrics = calculateHospitalMetrics(state);
    return ok(res, { kpis: buildKpis(metrics), pressure: calculateResourcePressure(state), generatedAt: new Date() });
  },
  activity: async (req, res) => ok(res, { activity: await dashboardService.buildActivity(Number(query(req).limit) || 20) }),
};

/* -------------------------------------------------------------- patients */
const patients = {
  list: async (req, res) => ok(res, await patientService.list({ auth: req.auth, query: query(req) })),
  mine: async (req, res) => ok(res, await patientService.mine({ auth: req.auth, query: query(req) })),
  detail: async (req, res) => ok(res, await patientService.getById({ auth: req.auth, id: req.params.id })),
  create: async (req, res) => mutation(res, await patientService.create({ auth: req.auth, payload: body(req) }), 201),
  update: async (req, res) => mutation(res, await patientService.update({ auth: req.auth, id: req.params.id, payload: body(req) })),
  discharge: async (req, res) => mutation(res, await patientService.discharge({ auth: req.auth, id: req.params.id, ...body(req) })),
  recordRequirement: async (req, res) =>
    mutation(res, await patientService.recordRequirement({ auth: req.auth, id: req.params.id, ...body(req) })),
};

/* ----------------------------------------------------------------- queue */
const queue = {
  list: async (req, res) => ok(res, await queueService.list({ query: query(req), scopeAuth: req.auth })),
  add: async (req, res) => mutation(res, await queueService.add({ auth: req.auth, payload: body(req) }), 201),
  escalate: async (req, res) => mutation(res, await queueService.escalate({ auth: req.auth, id: req.params.id, reason: body(req).reason })),
};

/* ------------------------------------------------------------------ beds */
const beds = {
  list: async (req, res) => ok(res, await bedService.list({ wardId: query(req).wardId || null })),
  wards: async (req, res) => ok(res, await bedService.wardStats()),
  assign: async (req, res) => mutation(res, await bedService.assign({ auth: req.auth, bedId: req.params.id, ...body(req) })),
  release: async (req, res) => mutation(res, await bedService.release({ auth: req.auth, bedId: req.params.id, ...body(req) })),
  setStatus: async (req, res) => mutation(res, await bedService.setStatus({ auth: req.auth, bedId: req.params.id, ...body(req) })),
};

/* ----------------------------------------------------------------- staff */
const staff = {
  doctors: async (req, res) => ok(res, await staffService.listDoctors({ query: query(req) })),
  nurses: async (req, res) => ok(res, await staffService.listNurses({ query: query(req) })),
  myDuty: async (req, res) => ok(res, await staffService.myDuty({ auth: req.auth })),
  roster: async (req, res) => ok(res, await staffService.roster({})),
  setDoctorDuty: async (req, res) => mutation(res, await staffService.setDoctorDuty({ auth: req.auth, id: req.params.id, ...body(req) })),
  setNurseDuty: async (req, res) => mutation(res, await staffService.setNurseDuty({ auth: req.auth, id: req.params.id, ...body(req) })),
};

/* ------------------------------------------------------------- equipment */
const equipment = {
  list: async (req, res) => ok(res, await equipmentService.list({ query: query(req) })),
  reserve: async (req, res) => mutation(res, await equipmentService.reserve({ auth: req.auth, ...body(req) })),
  release: async (req, res) => mutation(res, await equipmentService.release({ auth: req.auth, ...body(req) })),
};

const emergencyResources = {
  list: async (req, res) => ok(res, await emergencyResourceService.list()),
  reinforce: async (req, res) => mutation(res, await emergencyResourceService.reinforce({ auth: req.auth, ...body(req) })),
};

/* -------------------------------------------------------------------- OT */
const ot = {
  list: async (req, res) => ok(res, await otService.list()),
  conflicts: async (req, res) => ok(res, await otService.conflicts()),
  hold: async (req, res) =>
    mutation(res, await otService.holdTheatre({ auth: req.auth, theatreId: req.params.id || body(req).theatreId, ...body(req) })),
  release: async (req, res) => mutation(res, await otService.releaseHold({ auth: req.auth, theatreId: req.params.id, ...body(req) })),
};

/* ------------------------------------------------------------ simulation */
const simulation = {
  current: async (req, res) => ok(res, await simulationService.current()),
  run: async (req, res) => mutation(res, await simulationService.run({ auth: req.auth, ...body(req) })),
  revert: async (req, res) => mutation(res, await simulationService.revert({ auth: req.auth, id: req.params.id || 'current' })),
};

/* ---------------------------------------------------------- optimization */
const optimization = {
  latest: async (req, res) => ok(res, await optimizationService.latest()),
  conflicts: async (req, res) => ok(res, { conflicts: await optimizationService.conflictsFor() }),
  run: async (req, res) => mutation(res, await optimizationService.run({ auth: req.auth, ...body(req) })),
  approveRecommendation: async (req, res) =>
    mutation(res, await optimizationService.approveRecommendation({ auth: req.auth, id: req.params.id, ...body(req) })),
  rejectRecommendation: async (req, res) =>
    mutation(res, await optimizationService.rejectRecommendation({ auth: req.auth, id: req.params.id, reason: body(req).reason })),
};

/* ------------------------------------------------------------ allocation */
const allocations = {
  list: async (req, res) => ok(res, await allocationService.list({ status: query(req).status, approvalId: query(req).approvalId })),
  approvals: async (req, res) => ok(res, await allocationService.approvals({})),
  approve: async (req, res) => mutation(res, await allocationService.approve({ auth: req.auth, id: req.params.id, ...body(req) })),
  reject: async (req, res) => mutation(res, await allocationService.reject({ auth: req.auth, id: req.params.id, reason: body(req).reason })),
};

/* ---------------------------------------------------------------- alerts */
const alerts = {
  list: async (req, res) => ok(res, { alerts: await alertService.list(query(req)), generatedAt: new Date() }),
  sync: async (req, res) => mutation(res, { created: await alertService.syncCapacityAlerts({ auth: req.auth }) }),
  acknowledge: async (req, res) => mutation(res, await alertService.updateStatus(req.params.id, 'ACKNOWLEDGED')),
  resolve: async (req, res) => mutation(res, await alertService.updateStatus(req.params.id, 'RESOLVED')),
  acknowledgeAll: async (req, res) => mutation(res, await alertService.acknowledgeAll()),
};

/* --------------------------------------------------------- notifications */
const notifications = {
  list: async (req, res) => {
    const result = await notificationService.listForUser(req.auth.userId, {
      unreadOnly: query(req).unreadOnly === 'true',
      limit: query(req).limit,
    });
    return ok(res, result);
  },
  markRead: async (req, res) => mutation(res, await notificationService.markRead(req.auth.userId, req.params.id)),
  markAllRead: async (req, res) => mutation(res, await notificationService.markAllRead(req.auth.userId)),
};

/* ----------------------------------------------------------------- tasks */
const tasks = {
  list: async (req, res) => ok(res, await clinicalTaskService.list({ auth: req.auth, query: query(req) })),
  complete: async (req, res) => mutation(res, await clinicalTaskService.complete({ auth: req.auth, id: req.params.id, ...body(req) })),
  annotate: async (req, res) => mutation(res, await clinicalTaskService.annotate({ auth: req.auth, id: req.params.id, note: body(req).note })),
};

/* ------------------------------------------------------------- HE-02 AI */
/* Thin translation only: the service decides, the controller answers. Every
   handler returns a payload that states whether a trained model answered. */
const ai = {
  health: async (req, res) => ok(res, { ai: await aiService.serviceStatus() }),
  models: async (req, res) => ok(res, await aiService.models()),
  demandForecast: async (req, res) => ok(res, await aiService.prediction({ target: 'demand' })),
  resourceForecast: async (req, res) => ok(res, await aiService.prediction({ target: 'resources' })),
  pressure: async (req, res) => ok(res, await aiService.prediction({ target: 'pressure' })),
  surge: async (req, res) => ok(res, await aiService.prediction({ target: 'surge' })),
  patientFlow: async (req, res) => ok(res, await aiService.prediction({ target: 'patientFlow' })),
  equipmentDemand: async (req, res) => ok(res, await aiService.prediction({ target: 'equipment' })),
  doctorWorkload: async (req, res) => ok(res, await aiService.prediction({ target: 'doctorWorkload' })),
  nurseWorkload: async (req, res) => ok(res, await aiService.prediction({ target: 'nurseWorkload' })),
  advisory: async (req, res) => mutation(res, await aiService.advisoryOrFallback({ auth: req.auth, ...body(req) })),
  latestAdvisory: async (req, res) => ok(res, await aiService.latestAdvisory()),
  simulate: async (req, res) => mutation(res, await aiService.simulateOrFallback({ auth: req.auth, ...body(req) })),
  history: async (req, res) => ok(res, { runs: await aiService.history({ limit: Number(query(req).limit) || 10 }) }),
  runDetail: async (req, res) => ok(res, await aiService.runDetail(req.params.reference)),
};

/* ---------------------------------------------------------------- system */
const system = {
  health: async (req, res) => {
    const database = await checkDatabase();
    const state = await loadState({ simulationId: 'auto' });
    const metrics = calculateHospitalMetrics(state);
    const status = database.ok ? 'ok' : 'degraded';
    return res.status(database.ok ? 200 : 503).json({
      status,
      service: 'MediCore API',
      version: process.env.npm_package_version || '1.0.0',
      database,
      operational: {
        beds: metrics.beds.total,
        occupancyPercentage: metrics.beds.occupancyPercentage,
        queue: metrics.queue.total,
        doctorsOnDuty: metrics.doctors.onDuty,
        nursesOnDuty: metrics.nurses.onDuty,
        pressure: metrics.pressure.overall,
        pressureBand: metrics.pressure.band,
        surgeActive: metrics.surgeActive,
      },
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  },
  audit: async (req, res) => ok(res, { entries: await auditService.list({ limit: query(req).limit || 100 }) }),
};

const groups = {
  auth,
  ai,
  dashboard,
  patients,
  queue,
  beds,
  staff,
  equipment,
  emergencyResources,
  ot,
  simulation,
  optimization,
  allocations,
  alerts,
  notifications,
  tasks,
  system,
};

/* Every exported handler is wrapped exactly once. */
const controllers = Object.entries(groups).reduce((accumulator, [groupName, group]) => {
  accumulator[groupName] = Object.entries(group).reduce((wrapped, [name, handler]) => {
    wrapped[name] = wrap(handler);
    return wrapped;
  }, {});
  return accumulator;
}, {});

module.exports = { ...controllers, wrap };
