/**
 * Optimization service (§23–27, §30–31).
 *
 * Runs the multi-resource engine over the current (or projected surge) state,
 * stores the run together with its recommendations, and raises the approval
 * request the resource coordinator decides on.
 *
 * Nothing is applied here. A recommendation only becomes an allocation after a
 * human confirms it, and only then does the transactional allocation writer run.
 */

const { prisma } = require('../config/database');
const { loadState } = require('../repositories/hospitalStateRepository');
const { optimizeResources } = require('../optimization/resourceOptimizer');
const { detectConflicts } = require('../optimization/constraintEngine');
const { ApiError } = require('../utils/ApiError');
const { emit, EVENTS, room } = require('../socket/bus');
const { randomRef } = require('../utils/ids');
const audit = require('./auditService');
const aiService = require('./aiService');
const notification = require('./notificationService');

const OPT_ROOMS = [room.role('command_center'), room.role('resource_coordinator')];

const toRecommendation = (row) => ({
  id: row.reference,
  dbId: row.id,
  resource: row.resource,
  resourceCode: row.resourceCode,
  action: row.action,
  title: row.title,
  summary: row.summary,
  detail: row.detail,
  highlight: row.highlight,
  quantity: row.quantity,
  requiresApproval: row.requiresApproval,
  reason: row.reason,
  score: row.score,
  options: row.options,
  status: row.status,
  rejectedReason: row.rejectedReason,
  rejectedBy: row.rejectedBy,
});

/**
 * Runs the optimizer.
 * @param {object} options
 * @param {object} options.auth
 * @param {object} options.selections  chosen option per recommendation id
 * @param {boolean} options.createApproval  raise the coordinator approval request
 */
async function run({ auth, selections = {}, createApproval = true, mode = 'current' } = {}) {
  const state = await loadState({ simulationId: 'auto' });
  const result = optimizeResources(state, { selections });

  const runRow = await prisma.$transaction(async (tx) => {
    const existing = await tx.optimizationRun.findFirst({ where: { status: 'RECOMMENDATION_READY' } });

    const run_ = existing
      ? await tx.optimizationRun.update({
          where: { id: existing.id },
          data: {
            requestedById: auth.userId || null,
            requestedByName: auth.staffRef ? `${auth.name} · ${auth.staffRef}` : auth.name,
            mode,
            status: 'RECOMMENDATION_READY',
            selections,
            impact: result.impact,
            conflicts: result.conflicts,
            pressure: result.analysis.pressure,
            analysisRows: result.analysis.analysisRows,
            generatedAt: new Date(),
          },
        })
      : await tx.optimizationRun.create({
          data: {
            reference: randomRef('OPT'),
            requestedById: auth.userId || null,
            requestedByName: auth.staffRef ? `${auth.name} · ${auth.staffRef}` : auth.name,
            mode,
            status: 'RECOMMENDATION_READY',
            selections,
            impact: result.impact,
            conflicts: result.conflicts,
            pressure: result.analysis.pressure,
            analysisRows: result.analysis.analysisRows,
          },
        });

    await tx.optimizationRecommendation.deleteMany({ where: { runId: run_.id } });
    for (const recommendation of result.recommendations) {
      await tx.optimizationRecommendation.create({
        data: {
          reference: recommendation.id,
          runId: run_.id,
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
          score: recommendation.score || {},
          options: recommendation.options || [],
          status: 'OPEN',
        },
      });
    }
    return run_;
  }, { timeout: 30000 });

  const recommendations = await prisma.optimizationRecommendation.findMany({ where: { runId: runRow.id }, orderBy: { id: 'asc' } });

  let approval = null;
  if (createApproval && recommendations.length && !selections.keepPending) {
    approval = await raiseApproval({ auth, run: runRow, recommendations, payload: result });
  }

  audit.record({
    action: 'OPTIMIZATION_RUN',
    auth,
    entity: 'OptimizationRun',
    entityId: runRow.reference,
    detail: {
      message: `Multi-resource optimization completed — ${recommendations.length} recommendation(s), ${result.conflicts.length} conflict(s)`,
      tone: 'success',
    },
  });

  emit(
    EVENTS.OPTIMIZATION_COMPLETED,
    {
      reference: runRow.reference,
      recommendations: recommendations.length,
      conflicts: result.conflicts.length,
      pressure: result.analysis.pressure.overall,
      approvalId: approval ? approval.id : null,
    },
    { rooms: OPT_ROOMS },
  );

  await notification.notify({
    userIds: await notification.userIdsForRole('resource_coordinator'),
    title: approval ? `Approval request ${approval.id} awaiting your review` : 'Optimization completed — review required',
    body: approval
      ? `${approval.title}. ${recommendations.length} recommendation(s) covering beds, ICU, staff, equipment and theatres. Approval is required before any resource is allocated.`
      : `${recommendations.length} recommendation(s) from the multi-resource optimizer. No allocation is applied until a coordinator confirms.`,
    type: 'Operational',
    category: 'Approval',
    actionLabel: 'Open pending approvals',
    actionTo: '/resources/approvals',
  });

  /* A new optimization run changes what the command centre's AI panel shows. */
  if (typeof aiService?.invalidateAdvisoryCache === 'function') {
    aiService.invalidateAdvisoryCache();
  }

  return {
    reference: runRow.reference,
    runId: runRow.id,
    status: runRow.status,
    generatedAt: runRow.generatedAt,
    recommended: recommendations.length,
    recommendations: recommendations.map(toRecommendation),
    impact: result.impact,
    projectedImpact: result.projectedImpact,
    analysis: result.analysis,
    conflicts: result.conflicts,
    selected: selections,
    approval,
    decisionSupportOnly: true,
    note: 'Recommendations are decision support. No resource is allocated until the resource coordinator approves and the allocation transaction commits.',
  };
}

/** Builds the coordinator approval request from a run. */
async function raiseApproval({ auth, run, recommendations, payload }) {
  const summary = {
    doctors: countResource(recommendations, 'DOCTOR'),
    nurses: countResource(recommendations, 'NURSE'),
    generalBeds: quantityOf(recommendations, 'REC-BED-01'),
    ventilators: quantityOf(recommendations, 'REC-EQP-01'),
    icuOptions: (recommendations.find((entry) => entry.reference === 'REC-ICU-01')?.options || []).map((option) => option.label),
    otTheatres: quantityOf(recommendations, 'REC-OT-01'),
    emergencyCoverage: quantityOf(recommendations, 'REC-EMG-01'),
    resourceCodes: recommendations.map((entry) => entry.resourceCode),
  };

  const pending = await prisma.approval.findFirst({ where: { status: 'PENDING_REVIEW' } });
  const data = {
    title: `Surge response — ${recommendations.length} resource recommendation(s)`,
    subtitle: `${recommendations.map((entry) => entry.reference).join(' · ')}`,
    priority: payload.conflicts.some((conflict) => conflict.severity === 'Critical') ? 'Critical' : 'High',
    status: 'PENDING_REVIEW',
    summary,
    recommendationIds: recommendations.map((entry) => entry.reference),
    conflictsRaised: payload.conflicts.length,
    impact: payload.impact,
    optimizationId: run.id,
    requestedById: auth.userId || null,
    requestedByName: auth.staffRef ? `${auth.name} · ${auth.staffRef}` : auth.name,
    reason: null,
    decidedAt: null,
    decidedById: null,
    decidedByName: null,
  };

  const approval = pending
    ? await prisma.approval.update({ where: { id: pending.id }, data })
    : await prisma.approval.create({ data: { reference: randomRef('APR'), ...data } });

  /* One allocation row per resource is staged as PENDING_APPROVAL: proposed,
     not applied. The transactional writer in allocationService applies them. */
  await prisma.allocation.deleteMany({ where: { approvalId: approval.id, status: { in: ['PROPOSED', 'PENDING_APPROVAL'] } } });
  for (const recommendation of recommendations) {
    const mapped = mapAllocationType(recommendation);
    await prisma.allocation.create({
      data: {
        reference: randomRef('ALL'),
        type: mapped.type,
        resourceLabel: recommendation.title,
        quantity: recommendation.quantity,
        status: 'PENDING_APPROVAL',
        reason: recommendation.reason,
        allocatedById: auth.userId || null,
        approvalId: approval.id,
        bedId: mapped.bedId,
        doctorId: mapped.doctorId,
        nurseId: mapped.nurseId,
        equipmentId: mapped.equipmentId,
      },
    });
  }

  return {
    id: approval.reference,
    dbId: approval.id,
    title: approval.title,
    status: 'Pending Review',
    priority: approval.priority,
    summary,
    recommendationIds: approval.recommendationIds,
    conflictsRaised: approval.conflictsRaised,
    impact: approval.impact,
    optimizationId: run.reference,
    requestedBy: approval.requestedByName,
    createdAt: approval.createdAt,
  };
}

const countResource = (recommendations, code) =>
  recommendations.filter((entry) => entry.resourceCode === code).reduce((sum, entry) => sum + (entry.quantity || 0), 0);

const quantityOf = (recommendations, reference) => {
  const row = recommendations.find((entry) => entry.reference === reference);
  return row ? row.quantity : 0;
};

/** Recommendation → allocation type + the concrete target it will touch. */
function mapAllocationType(recommendation) {
  switch (recommendation.resourceCode) {
    case 'BED':
      return { type: 'BED' };
    case 'ICU_BED':
      return { type: 'ICU_BED' };
    case 'DOCTOR':
      return { type: 'DOCTOR' };
    case 'NURSE':
      return { type: 'NURSE' };
    case 'EQUIPMENT':
      return { type: 'EQUIPMENT', equipmentId: 'ventilators' };
    case 'OT':
      return { type: 'OT' };
    case 'EMERGENCY_RESOURCE':
      return { type: 'EMERGENCY_RESOURCE' };
    default:
      return { type: 'BED' };
  }
}

/** Latest stored run (used by the coordinator's board and by /api/optimization). */
async function latest() {
  const run = await prisma.optimizationRun.findFirst({
    where: { status: 'RECOMMENDATION_READY' },
    orderBy: { generatedAt: 'desc' },
    include: { recommendations: true },
  });
  if (!run) return { status: 'IDLE', recommendations: [], conflicts: [], impact: [] };
  return {
    reference: run.reference,
    runId: run.id,
    status: run.status,
    generatedAt: run.generatedAt,
    requestedBy: run.requestedByName,
    selections: run.selections,
    recommendations: run.recommendations.map(toRecommendation),
    impact: run.impact,
    conflicts: run.conflicts,
    pressure: run.pressure,
    analysisRows: run.analysisRows,
  };
}

/** Rejects a single recommendation; the rest of the run stays open (§32). */
async function rejectRecommendation({ auth, id, reason }) {
  const row = await prisma.optimizationRecommendation.findFirst({
    where: { reference: id, status: 'OPEN' },
    orderBy: { createdAt: 'desc' },
  }) || await prisma.optimizationRecommendation.findFirst({
    where: { reference: id },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) throw ApiError.notFound(`Recommendation ${id} was not found.`);

  const updated = await prisma.optimizationRecommendation.update({
    where: { id: row.id },
    data: {
      status: 'REJECTED',
      rejectedReason: reason,
      rejectedBy: auth.staffRef ? `${auth.name} · ${auth.staffRef}` : auth.name,
      rejectedAt: new Date(),
    },
  });

  await prisma.allocation.updateMany({
    where: { approvalId: { not: null }, status: { in: ['PROPOSED', 'PENDING_APPROVAL'] }, resourceLabel: { contains: updated.reference } },
    data: { status: 'REJECTED', rejectedAt: new Date(), reason },
  });

  audit.record({
    action: 'RECOMMENDATION_REJECTED',
    auth,
    entity: 'OptimizationRecommendation',
    entityId: updated.reference,
    detail: { message: `${updated.reference} rejected — ${reason}`, tone: 'alert' },
  });
  emit(
    EVENTS.OPTIMIZATION_COMPLETED,
    { reference: row.runId, rejected: updated.reference, reason },
    { rooms: OPT_ROOMS },
  );

  return {
    id: updated.reference,
    status: 'Rejected',
    rawStatus: updated.status,
    reason: updated.rejectedReason,
    rejectedReason: updated.rejectedReason,
    rejectedBy: updated.rejectedBy,
  };
}

/**
 * Approves a recommendation from the command center or coordinator (§2 Optimization approval).
 */
async function approveRecommendation({ auth, id, selections = {}, note = null }) {
  const allocationService = require('./allocationService');
  return allocationService.approve({
    auth,
    id,
    selections,
    note: note || `Approved by ${auth.name} (Command Center)`,
  });
}

const conflictsFor = async () => {
  const state = await loadState({ simulationId: 'auto' });
  return detectConflicts(state);
};

module.exports = { run, latest, approveRecommendation, rejectRecommendation, conflictsFor, toRecommendation };
