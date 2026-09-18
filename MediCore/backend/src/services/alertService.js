/**
 * Alert service (§44, §45).
 *
 * Alerts are operational notices — never diagnoses. Severities are
 * CRITICAL | HIGH | OPERATIONAL | INFO, and every alert can be acknowledged
 * and resolved by the teams that own it.
 */

const { prisma } = require('../config/database');
const { emit, room, EVENTS } = require('../socket/bus');
const { loadState, toAlert } = require('../repositories/hospitalStateRepository');
const { calculateHospitalMetrics } = require('./metricsService');
const { randomRef } = require('../utils/ids');

const COMMAND_ROOMS = [room.role('command_center'), room.role('resource_coordinator')];

/** Severity for a resource gap — an operational indicator, not a clinical one. */
const severityForGap = (gap, criticalThreshold = 3) => {
  if (gap <= 0) return 'INFO';
  return gap >= criticalThreshold ? 'CRITICAL' : 'HIGH';
};

/**
 * Recomputes the standing capacity alerts from live data. This keeps the alert
 * list truthful: an alert disappears when the underlying gap closes, instead of
 * staying red forever.
 */
async function syncCapacityAlerts({ auth = null } = {}) {
  const state = await loadState({ simulationId: 'auto' });
  const metrics = calculateHospitalMetrics(state);
  const definitions = [
    {
      reference: 'ALR-ICU-01',
      condition: metrics.queue.icuRequests > metrics.beds.icu.available,
      gap: metrics.queue.icuRequests - metrics.beds.icu.available,
      type: 'Critical',
      category: 'Capacity',
      title: 'ICU capacity under pressure',
      description: `${metrics.queue.icuRequests} ICU-level request(s) against ${metrics.beds.icu.available} vacant ICU bed(s). Escalation capacity review required by authorized staff.`,
      resource: 'ICU Beds',
      affectedResource: `ICU — ${metrics.beds.icu.committed} / ${metrics.beds.icu.units} committed`,
      actionLabel: 'View bed capacity',
      actionTo: '/command/beds',
    },
    {
      reference: 'ALR-QUEUE-01',
      condition: metrics.queue.total >= 5 && metrics.queue.critical > 0,
      gap: metrics.queue.critical,
      type: 'Critical',
      category: 'Queue',
      title: 'Emergency queue building up',
      description: `${metrics.queue.total} patient(s) waiting with ${metrics.queue.critical} critical case(s). Average wait ${metrics.queue.averageWait} minutes.`,
      resource: 'Emergency Queue',
      affectedResource: `Emergency — ${metrics.queue.total} waiting`,
      actionLabel: 'Open patient queue',
      actionTo: '/command/queue',
    },
    {
      reference: 'ALR-VENT-01',
      condition: metrics.equipment.ventilators.free < metrics.queue.ventilatorRequests,
      gap: metrics.queue.ventilatorRequests - metrics.equipment.ventilators.free,
      type: 'Critical',
      category: 'Equipment',
      title: 'Ventilator availability low',
      description: `${metrics.queue.ventilatorRequests} patient(s) require ventilation with ${metrics.equipment.ventilators.free} uncommitted ventilator unit(s) available.`,
      resource: 'Ventilators',
      affectedResource: `Equipment — ${metrics.equipment.ventilators.inUse}/${metrics.equipment.ventilators.total} in use`,
      actionLabel: 'Open equipment',
      actionTo: '/command/equipment',
    },
    {
      reference: 'ALR-WORK-01',
      condition: metrics.nurses.atConstraint > 0,
      gap: metrics.nurses.atConstraint,
      type: 'Operational',
      category: 'Workload',
      title: 'Nursing workload at configured constraint',
      description: `${metrics.nurses.atConstraint} nurse(s) are at the ${metrics.nurses.workloadLimit}-patient workload limit with ${metrics.nurses.available} deployable.`,
      resource: 'Nursing',
      affectedResource: `Nursing — workload index ${metrics.nurses.workloadIndex}`,
      actionLabel: 'View roster',
      actionTo: '/command/nurses',
    },
    {
      reference: 'ALR-OTS-01',
      condition: metrics.ot.active >= metrics.ot.total - metrics.ot.maintenance && state.otBacklog.length > 0,
      gap: state.otBacklog.length,
      type: 'Operational',
      category: 'Theatre',
      title: 'Theatre capacity fully committed',
      description: `${metrics.ot.active} of ${metrics.ot.total} theatres active with ${state.otBacklog.length} surgical request(s) outstanding. Schedule review with the theatre coordinator required.`,
      resource: 'Operating Theatres',
      affectedResource: `OT — ${metrics.ot.available} free · ${metrics.ot.maintenance} under maintenance`,
      actionLabel: 'Open OT scheduling',
      actionTo: '/resources/ot',
    },
    {
      reference: 'ALR-BED-01',
      condition: metrics.beds.available <= 5,
      gap: 6 - metrics.beds.available,
      type: 'Operational',
      category: 'Capacity',
      title: 'Few vacant beds remaining',
      description: `${metrics.beds.available} bed(s) are free across all wards with ${metrics.beds.cleaning} in cleaning turnaround and ${metrics.beds.maintenance} under maintenance.`,
      resource: 'Beds',
      affectedResource: `Beds — ${metrics.beds.committed} / ${metrics.beds.total} committed`,
      actionLabel: 'Open bed capacity',
      actionTo: '/command/beds',
    },
  ];

  const created = [];
  for (const definition of definitions) {
    if (!definition.condition) continue;
    const severity = severityForGap(definition.gap);
    const existing = await prisma.alert.findUnique({ where: { reference: definition.reference } });
    const payload = {
      type: definition.type,
      severity,
      category: definition.category,
      title: definition.title,
      description: definition.description,
      resource: definition.resource,
      affectedResource: definition.affectedResource,
      actionLabel: definition.actionLabel,
      actionTo: definition.actionTo,
      source: 'Capacity monitor',
    };
    if (existing) {
      const reactivated = existing.status === 'RESOLVED' ? 'ACTIVE' : existing.status;
      const updated = await prisma.alert.update({
        where: { reference: definition.reference },
        data: { ...payload, status: reactivated },
        include: { patient: { select: { patientNumber: true } } },
      });
      if (existing.status === 'RESOLVED') created.push(toAlert(updated));
      continue;
    }
    const row = await prisma.alert.create({
      data: { reference: definition.reference, ...payload },
      include: { patient: { select: { patientNumber: true } } },
    });
    created.push(toAlert(row));
  }

  created.forEach((alert) => {
    emit(EVENTS.ALERT_CREATED, { alert }, { rooms: COMMAND_ROOMS });
  });

  return created;
}

/** Creates an alert row and broadcasts it to the dashboards that can act. */
async function raise({
  reference = null,
  type = 'Operational',
  severity = 'OPERATIONAL',
  category = 'Operations',
  title,
  description,
  resource = null,
  affectedResource = null,
  actionLabel = null,
  actionTo = null,
  source = 'Constraint engine',
  patientId = null,
  extraRooms = [],
}) {
  const row = await prisma.alert.create({
    data: {
      reference: reference || randomRef('ALR'),
      type,
      severity,
      category,
      title,
      description,
      resource,
      affectedResource,
      actionLabel,
      actionTo,
      source,
      patientId,
    },
    include: { patient: { select: { patientNumber: true } } },
  });
  const alert = toAlert(row);
  emit(EVENTS.ALERT_CREATED, { alert }, { rooms: [...COMMAND_ROOMS, ...extraRooms] });
  return alert;
}

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'OPERATIONAL', 'INFO'];
const TYPE_ORDER = ['Critical', 'Operational'];

async function list({ status, category, severity, limit = 50 } = {}) {
  const rows = await prisma.alert.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(category ? { category } : {}),
      ...(severity ? { severity } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
    take: Math.min(Number(limit) || 50, 200),
    include: { patient: { select: { patientNumber: true } } },
  });
  return rows.map(toAlert).sort((a, b) => {
    const severityDelta = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (severityDelta !== 0) return severityDelta;
    const typeDelta = TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
    if (typeDelta !== 0) return typeDelta;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });
}

async function updateStatus(id, status) {
  const existing = await prisma.alert.findUnique({ where: { id } });
  if (!existing) return null;
  const data =
    status === 'ACKNOWLEDGED'
      ? { status: 'ACKNOWLEDGED', acknowledgedAt: new Date() }
      : { status: 'RESOLVED', resolvedAt: new Date() };
  const row = await prisma.alert.update({ where: { id }, data, include: { patient: { select: { patientNumber: true } } } });
  const alert = toAlert(row);
  emit(EVENTS.ALERT_CREATED, { alert, change: status }, { rooms: COMMAND_ROOMS });
  return alert;
}

async function acknowledgeAll() {
  const result = await prisma.alert.updateMany({
    where: { status: 'ACTIVE' },
    data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date() },
  });
  emit(EVENTS.ALERT_CREATED, { change: 'ACKNOWLEDGED_ALL', updated: result.count }, { rooms: COMMAND_ROOMS });
  return { updated: result.count };
}

module.exports = { syncCapacityAlerts, raise, list, updateStatus, acknowledgeAll, severityForGap };
