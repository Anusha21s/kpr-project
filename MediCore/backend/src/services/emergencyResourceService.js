/**
 * Emergency resource service (§24).
 *
 * Resuscitation bays, monitored emergency bays, trauma kits, the emergency OT
 * and the ambulance pool. Emergency capacity is never blocked by the planning
 * layer: reinforcement only ever *adds* capacity or opens capacity for review.
 */

const { prisma } = require('../config/database');
const { loadState } = require('../repositories/hospitalStateRepository');
const { calculateHospitalMetrics } = require('./metricsService');
const { ApiError } = require('../utils/ApiError');
const { emit, room, EVENTS } = require('../socket/bus');
const audit = require('./auditService');

const EMERGENCY_ROOMS = [room.role('command_center'), room.role('resource_coordinator')];

async function list() {
  const state = await loadState({ simulationId: 'auto' });
  const metrics = calculateHospitalMetrics(state);
  return {
    resources: metrics.emergencyResources,
    total: metrics.emergencyResources.length,
    demand: {
      emergencyBedRequests: metrics.queue.emergencyBedRequests,
      resusRequests: metrics.queue.resusRequests,
      ventilatorRequests: metrics.queue.ventilatorRequests,
      traumaCases: metrics.queue.total,
    },
    generatedAt: new Date(),
  };
}

/** Holds or releases emergency capacity for the incoming intake. */
async function reinforce({ auth, resourceId, action = 'hold', note = null, quantity = 1 }) {
  const resource = await prisma.emergencyResource.findUnique({ where: { id: resourceId } });
  if (!resource) throw ApiError.notFound(`Emergency resource ${resourceId} was not found.`);

  const delta = action === 'hold' ? Number(quantity) : -Number(quantity);
  const nextInUse = Math.min(resource.total, Math.max(0, resource.inUse + delta));

  const updated = await prisma.emergencyResource.update({
    where: { id: resourceId },
    data: {
      inUse: nextInUse,
      /* The hold note is recorded in the audit trail; the row carries the
         committed state so the boards read straight from the database. */
      status: nextInUse >= resource.total ? 'Committed' : nextInUse >= Math.ceil(resource.total * 0.7) ? 'Tight' : 'Available',
    },
  });

  audit.record({
    action: action === 'hold' ? 'EMERGENCY_CAPACITY_HELD' : 'EMERGENCY_CAPACITY_RELEASED',
    auth,
    entity: 'EmergencyResource',
    entityId: resourceId,
    detail: {
      message: `${resource.name}: ${action === 'hold' ? '+' : '-'}${quantity} unit(s)${note ? ` — ${note}` : ''}`,
      tone: 'info',
    },
  });
  emit(EVENTS.EQUIPMENT_UPDATED, { resourceId, inUse: updated.inUse }, { rooms: EMERGENCY_ROOMS });

  return {
    id: updated.id,
    name: updated.name,
    total: updated.total,
    inUse: updated.inUse,
    reserved: updated.reserved,
    available: Math.max(updated.total - updated.inUse - updated.reserved, 0),
    status: updated.status,
    note: note || (action === 'hold' ? 'Capacity reinforced for the incoming emergency intake' : 'Capacity released back to the pool'),
  };
}

module.exports = { list, reinforce };
