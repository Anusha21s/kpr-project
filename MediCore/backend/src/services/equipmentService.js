/**
 * Equipment service (§23, §43).
 *
 * Equipment is tracked per unit. Reserving a unit is a transactional hold with
 * a row lock, so two coordinators cannot reserve the same ventilator.
 */

const { prisma } = require('../config/database');
const { loadState } = require('../repositories/hospitalStateRepository');
const { calculateEquipmentAnalysis } = require('./metricsService');
const { ApiError } = require('../utils/ApiError');
const { emit, room, EVENTS } = require('../socket/bus');
const audit = require('./auditService');

const EQUIPMENT_ROOMS = [room.role('command_center'), room.role('resource_coordinator')];

async function list({ query = {} } = {}) {
  const state = await loadState({ simulationId: 'auto' });
  const analysis = calculateEquipmentAnalysis(state.equipment);
  let categories = analysis.categories;
  if (query.kind) categories = categories.filter((category) => category.kind === query.kind);
  if (query.available === 'true' || query.available === true) categories = categories.filter((category) => category.free > 0);

  const units = await prisma.equipmentUnit.findMany({
    where: query.categoryId ? { equipmentId: query.categoryId } : undefined,
    select: { id: true, equipmentId: true, inUse: true, reserved: true, status: true, reservedFor: true, patientId: true },
  });

  return {
    categories,
    units,
    total: categories.length,
    summary: {
      totalUnits: analysis.totalUnits,
      inUseUnits: analysis.inUseUnits,
      reservedUnits: analysis.reservedUnits,
      availableUnits: analysis.availableUnits,
      utilisation: analysis.utilisation,
      ventilators: analysis.ventilators ? { ...analysis.ventilators, units: undefined } : null,
      monitors: analysis.monitors ? { ...analysis.monitors, units: undefined } : null,
      otEquipment: analysis.otEquipment ? { ...analysis.otEquipment, units: undefined } : null,
    },
    generatedAt: new Date(),
  };
}

/**
 * Reserves free units of a category. Locks the unit rows, verifies they are
 * still free, then marks them reserved — all inside one transaction.
 */
async function reserve({ auth, categoryId, quantity = 1, reservedFor, unitIds = null }) {
  const result = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw`
      SELECT id, "inUse", "reserved", status FROM "EquipmentUnit"
      WHERE "equipmentId" = ${categoryId}
      ORDER BY id
      FOR UPDATE
    `;
    if (!Array.isArray(locked) || locked.length === 0) throw ApiError.notFound(`Equipment category ${categoryId} has no units.`);

    const free = locked.filter((unit) => !unit.inUse && !unit.reserved && (unitIds ? unitIds.includes(unit.id) : true));
    if (free.length < quantity) {
      throw ApiError.conflict(
        `Only ${free.length} free unit(s) of ${categoryId} remain — ${quantity} requested. Notification of the shortage is raised instead of over-committing equipment.`,
      );
    }

    const chosen = free.slice(0, quantity).map((unit) => unit.id);
    await tx.equipmentUnit.updateMany({
      where: { id: { in: chosen } },
      data: { reserved: true, status: 'Reserved', reservedFor: reservedFor || 'Reserved by the resource coordinator' },
    });

    const category = await tx.equipment.findUnique({ where: { id: categoryId } });

    return { chosen, category };
  });

  audit.record({
    action: 'EQUIPMENT_RESERVED',
    auth,
    entity: 'Equipment',
    entityId: categoryId,
    detail: { message: `${result.category.name}: ${result.chosen.length} unit(s) reserved — ${reservedFor}`, tone: 'info' },
  });
  emit(
    EVENTS.EQUIPMENT_UPDATED,
    { categoryId, reserved: result.chosen.length, unitIds: result.chosen },
    { rooms: EQUIPMENT_ROOMS },
  );

  return {
    categoryId,
    quantity: result.chosen.length,
    unitIds: result.chosen,
    reservedFor: reservedFor || 'Reserved by the resource coordinator',
    categoryName: result.category.name,
  };
}

async function release({ auth, categoryId, unitIds = [], reason = 'Reservation released' }) {
  const units = await prisma.equipmentUnit.findMany({
    where: { equipmentId: categoryId, ...(unitIds.length ? { id: { in: unitIds } } : {}), reserved: true },
  });
  if (!units.length) throw ApiError.notFound(`No reserved unit found for ${categoryId}.`);

  await prisma.equipmentUnit.updateMany({
    where: { id: { in: units.map((unit) => unit.id) } },
    data: { reserved: false, status: 'Available', reservedFor: null },
  });

  audit.record({
    action: 'EQUIPMENT_RELEASED',
    auth,
    entity: 'Equipment',
    entityId: categoryId,
    detail: { message: `${units.length} unit(s) of ${categoryId} released — ${reason}`, tone: 'info' },
  });
  emit(EVENTS.EQUIPMENT_UPDATED, { categoryId, released: units.length }, { rooms: EQUIPMENT_ROOMS });

  return { categoryId, quantity: units.length, unitIds: units.map((unit) => unit.id) };
}

module.exports = { list, reserve, release };
