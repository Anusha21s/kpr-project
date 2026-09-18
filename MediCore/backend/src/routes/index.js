/**
 * API routes (§15).
 *
 * Paths are exactly the ones the frontend already calls — the backend adapts to
 * the existing contract. Every route declares its authentication and its role
 * allow-list here, so the authorization rules of the whole API can be read in
 * one place.
 */

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { authorize, requirePermission } = require('../middleware/roles');
const { validate } = require('../middleware/validation');
const { loginLimiter } = require('../middleware/rateLimit');
const controllers = require('../controllers');
const v = require('../validators');

const router = express.Router();

const COMMAND = ['command_center'];
const COORDINATOR = ['resource_coordinator'];
const COMMAND_OR_COORDINATOR = ['command_center', 'resource_coordinator'];
const CLINICAL = ['doctor', 'nurse'];
const ANY_ROLE = ['command_center', 'doctor', 'nurse', 'resource_coordinator'];

router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/* ---------------------------------------------------------------- health */
router.get('/health', controllers.system.health);

/* ------------------------------------------------------------------ auth */
router.post('/auth/login', loginLimiter, validate(v.loginSchema), controllers.auth.login);
router.post('/auth/logout', authenticate, controllers.auth.logout);
router.get('/auth/me', authenticate, controllers.auth.me);

/* ------------------------------------------------------------- dashboard */
router.get('/dashboard/overview', authenticate, authorize(...ANY_ROLE), controllers.dashboard.overview);
router.get('/dashboard/kpis', authenticate, authorize(...ANY_ROLE), controllers.dashboard.kpis);
router.get('/dashboard/activity', authenticate, authorize(...ANY_ROLE), controllers.dashboard.activity);

/* -------------------------------------------------------------- patients */
router.get('/patients', authenticate, authorize(...ANY_ROLE), validate(v.patientQuery, 'query'), controllers.patients.list);
router.get('/patients/my', authenticate, authorize(...ANY_ROLE), validate(v.patientQuery, 'query'), controllers.patients.mine);
router.get('/patients/:id', authenticate, authorize(...ANY_ROLE), controllers.patients.detail);
router.post(
  '/patients',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR, ...CLINICAL),
  validate(v.patientCreateSchema),
  controllers.patients.create,
);
router.patch(
  '/patients/:id',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR, ...CLINICAL),
  validate(v.patientUpdateSchema),
  controllers.patients.update,
);
router.post(
  '/patients/:id/discharge',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR, ...CLINICAL),
  validate(v.patientDischargeSchema),
  controllers.patients.discharge,
);
router.post(
  '/patients/:id/requirement',
  authenticate,
  authorize(...CLINICAL, ...COMMAND_OR_COORDINATOR),
  validate(v.requirementSchema),
  controllers.patients.recordRequirement,
);

/* ----------------------------------------------------------------- queue */
router.get('/queue', authenticate, authorize(...ANY_ROLE), validate(v.queueQuery, 'query'), controllers.queue.list);
router.post('/queue', authenticate, authorize(...COMMAND_OR_COORDINATOR, ...CLINICAL), validate(v.queueEntrySchema), controllers.queue.add);
router.post(
  '/queue/:id/escalate',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR, ...CLINICAL),
  validate(v.escalationSchema),
  controllers.queue.escalate,
);

/* ------------------------------------------------------------------ beds */
router.get('/beds', authenticate, authorize(...ANY_ROLE), validate(v.bedQuery, 'query'), controllers.beds.list);
router.get('/beds/wards', authenticate, authorize(...ANY_ROLE), controllers.beds.wards);
router.post(
  '/beds/:id/assign',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR),
  requirePermission('beds:write', 'allocations:confirm'),
  validate(v.bedAssignSchema),
  controllers.beds.assign,
);
router.post(
  '/beds/:id/release',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR, ...CLINICAL),
  validate(v.bedReleaseSchema),
  controllers.beds.release,
);
router.patch(
  '/beds/:id/status',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR),
  validate(v.bedStatusSchema),
  controllers.beds.setStatus,
);

/* ----------------------------------------------------------------- staff */
router.get('/doctors', authenticate, authorize(...ANY_ROLE), validate(v.doctorQuery, 'query'), controllers.staff.doctors);
router.get('/nurses', authenticate, authorize(...ANY_ROLE), validate(v.nurseQuery, 'query'), controllers.staff.nurses);
router.get('/doctors/me/duty', authenticate, authorize(...CLINICAL), controllers.staff.myDuty);
router.get('/nurses/me/duty', authenticate, authorize(...CLINICAL), controllers.staff.myDuty);
router.get('/staff/roster', authenticate, authorize(...ANY_ROLE), controllers.staff.roster);
router.patch(
  '/doctors/:id/duty',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR),
  validate(v.dutySchema),
  controllers.staff.setDoctorDuty,
);
router.patch(
  '/nurses/:id/duty',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR),
  validate(v.dutySchema),
  controllers.staff.setNurseDuty,
);

/* ------------------------------------------------------------- equipment */
router.get('/equipment', authenticate, authorize(...ANY_ROLE), validate(v.equipmentQuery, 'query'), controllers.equipment.list);
router.post(
  '/equipment/reserve',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR),
  requirePermission('equipment:write', 'allocations:confirm'),
  validate(v.equipmentReserveSchema),
  controllers.equipment.reserve,
);
router.post(
  '/equipment/release',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR),
  requirePermission('equipment:write', 'allocations:confirm'),
  validate(v.equipmentReleaseSchema),
  controllers.equipment.release,
);

/* --------------------------------------------------- emergency resources */
router.get('/emergency-resources', authenticate, authorize(...ANY_ROLE), controllers.emergencyResources.list);
router.post(
  '/emergency-resources/reinforce',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR),
  validate(v.emergencyReinforceSchema),
  controllers.emergencyResources.reinforce,
);

/* -------------------------------------------------------------------- OT */
router.get('/ot', authenticate, authorize(...ANY_ROLE), controllers.ot.list);
router.get('/ot/conflicts', authenticate, authorize(...ANY_ROLE), controllers.ot.conflicts);
router.post(
  '/ot/:id/hold',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR),
  requirePermission('ot:write', 'allocations:confirm'),
  validate(v.otHoldSchema.omit({ theatreId: true })),
  controllers.ot.hold,
);
router.post(
  '/ot/hold',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR),
  requirePermission('ot:write', 'allocations:confirm'),
  validate(v.otHoldSchema),
  controllers.ot.hold,
);
router.post(
  '/ot/:id/release',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR),
  requirePermission('ot:write', 'allocations:confirm'),
  validate(v.otReleaseSchema),
  controllers.ot.release,
);

/* ------------------------------------------------------------ simulation */
router.get('/simulation', authenticate, authorize(...ANY_ROLE), controllers.simulation.current);
router.post('/simulation', authenticate, authorize(...COMMAND_OR_COORDINATOR), validate(v.simulationSchema), controllers.simulation.run);
router.post('/simulation/revert', authenticate, authorize(...COMMAND_OR_COORDINATOR), controllers.simulation.revert);
router.post('/simulation/:id/revert', authenticate, authorize(...COMMAND_OR_COORDINATOR), controllers.simulation.revert);

/* ---------------------------------------------------------- optimization */
router.get('/optimization', authenticate, authorize(...ANY_ROLE), controllers.optimization.latest);
router.get('/optimization/conflicts', authenticate, authorize(...ANY_ROLE), controllers.optimization.conflicts);
router.post(
  '/optimization',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR),
  validate(v.optimizationSchema),
  controllers.optimization.run,
);
router.post(
  '/optimization/recommendations/:id/approve',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR),
  requirePermission('allocations:confirm', 'approvals:decide'),
  controllers.optimization.approveRecommendation,
);
router.post(
  '/optimization/recommendations/:id/reject',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR),
  validate(v.rejectionSchema),
  controllers.optimization.rejectRecommendation,
);

/* ------------------------------------------------------------ allocation */
router.get('/allocations', authenticate, authorize(...COMMAND_OR_COORDINATOR, ...CLINICAL), validate(v.allocationQuery, 'query'), controllers.allocations.list);
router.get('/allocations/approvals', authenticate, authorize(...COMMAND_OR_COORDINATOR), controllers.allocations.approvals);
router.post(
  '/allocations/:id/approve',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR),
  requirePermission('allocations:confirm', 'approvals:decide'),
  validate(v.approvalDecisionSchema),
  controllers.allocations.approve,
);
router.post(
  '/allocations/:id/reject',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR),
  requirePermission('allocations:reject', 'approvals:decide'),
  validate(v.rejectionSchema),
  controllers.allocations.reject,
);

/* ---------------------------------------------------------------- alerts */
router.get('/alerts', authenticate, authorize(...ANY_ROLE), validate(v.alertQuery, 'query'), controllers.alerts.list);
router.post('/alerts/sync', authenticate, authorize(...COMMAND_OR_COORDINATOR), controllers.alerts.sync);
router.post('/alerts/acknowledge-all', authenticate, authorize(...ANY_ROLE), controllers.alerts.acknowledgeAll);
router.post('/alerts/:id/acknowledge', authenticate, authorize(...ANY_ROLE), controllers.alerts.acknowledge);
router.post('/alerts/:id/resolve', authenticate, authorize(...ANY_ROLE), controllers.alerts.resolve);

/* --------------------------------------------------------- notifications */
router.get('/notifications', authenticate, authorize(...ANY_ROLE), validate(v.notificationQuery, 'query'), controllers.notifications.list);
router.post('/notifications/read-all', authenticate, authorize(...ANY_ROLE), controllers.notifications.markAllRead);
router.post('/notifications/:id/read', authenticate, authorize(...ANY_ROLE), controllers.notifications.markRead);

/* ----------------------------------------------------------------- tasks */
router.get('/tasks', authenticate, authorize(...ANY_ROLE), validate(v.taskQuery, 'query'), controllers.tasks.list);
router.post('/tasks/:id/complete', authenticate, authorize(...ANY_ROLE), validate(v.taskNoteSchema.partial()), controllers.tasks.complete);
router.post('/tasks/:id/note', authenticate, authorize(...ANY_ROLE), validate(v.taskNoteSchema), controllers.tasks.annotate);

/* ------------------------------------------------------- HE-02 AI layer (§AI) */
/* Decision support only. Reads are open to the roles that work with the
   forecast; the run endpoints (advisory, simulation, optimizer) are restricted
   to the command centre and the resource coordinator, because those are the
   roles that own an operational plan. No AI route applies anything: every plan
   it returns travels through the approval workflow above. */
router.get('/ai/health', authenticate, authorize(...ANY_ROLE), controllers.ai.health);
router.get('/ai/models', authenticate, authorize(...COMMAND, ...COORDINATOR), controllers.ai.models);

router.post('/ai/demand/forecast', authenticate, authorize(...ANY_ROLE), controllers.ai.demandForecast);
router.post('/ai/resources/forecast', authenticate, authorize(...ANY_ROLE), controllers.ai.resourceForecast);
router.post('/ai/pressure/predict', authenticate, authorize(...ANY_ROLE), controllers.ai.pressure);
router.post('/ai/surge/detect', authenticate, authorize(...ANY_ROLE), controllers.ai.surge);
router.post('/ai/patient-flow/predict', authenticate, authorize(...ANY_ROLE), controllers.ai.patientFlow);
router.post('/ai/equipment-demand/predict', authenticate, authorize(...ANY_ROLE), controllers.ai.equipmentDemand);
/* Clinicians see workload forecasts for their own roster context. */
router.post(
  '/ai/doctor-workload/predict',
  authenticate,
  authorize(...ANY_ROLE),
  controllers.ai.doctorWorkload,
);
router.post(
  '/ai/nurse-workload/predict',
  authenticate,
  authorize(...ANY_ROLE),
  controllers.ai.nurseWorkload,
);

router.post(
  '/ai/advisory',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR),
  validate(v.advisorySchema),
  controllers.ai.advisory,
);
router.get('/ai/advisory/latest', authenticate, authorize(...COMMAND_OR_COORDINATOR), controllers.ai.latestAdvisory);

router.post(
  '/ai/simulate',
  authenticate,
  authorize(...COMMAND_OR_COORDINATOR),
  validate(v.aiSimulationSchema),
  controllers.ai.simulate,
);

router.get('/ai/runs', authenticate, authorize(...COMMAND_OR_COORDINATOR), validate(v.aiRunQuery, 'query'), controllers.ai.history);
router.get('/ai/runs/:reference', authenticate, authorize(...COMMAND_OR_COORDINATOR), controllers.ai.runDetail);

/* ----------------------------------------------------------------- audit */
router.get('/audit', authenticate, authorize(...COMMAND), controllers.system.audit);

module.exports = router;
