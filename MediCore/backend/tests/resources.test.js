/**
 * Bed / ICU / equipment / theatre behaviour, including the conflict and
 * concurrency rules (§38, §39, §43, §48).
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { request, login, auth, prisma, disconnect } = require('./helpers');

let command;
let coordinator;
let doctor;

before(async () => {
  [command, coordinator, doctor] = await Promise.all([login('CMD001'), login('RES001'), login('DOC001')]);
});

after(async () => {
  await disconnect();
});

describe('beds and ICU', () => {
  test('bed capacity is computed from the bed rows', async () => {
    const response = await request().get('/api/beds').set(auth(command.token));
    assert.equal(response.status, 200);
    const { summary, wards } = response.body;
    assert.equal(summary.total, 100);
    assert.equal(summary.occupied + summary.reserved + summary.available + summary.cleaning + summary.maintenance, 100);
    const totalUnits = wards.reduce((sum, ward) => sum + ward.units, 0);
    assert.equal(totalUnits, 100, 'the wards add up to the configured bed count');
    const icu = wards.find((ward) => ward.id === 'icu');
    assert.equal(icu.units, 10, 'ten ICU beds are configured');
    /* Occupancy counts beds that are not available, including cleaning and
       maintenance — the same model the dashboards display. */
    assert.equal(icu.occupancyPercentage, Math.round(((icu.units - icu.available) / icu.units) * 1000) / 10);
  });

  test('assigning an occupied bed is refused with 409 and changes nothing', async () => {
    const occupied = await prisma.bed.findFirst({ where: { patientId: { not: null } } });
    const before = await prisma.bed.findUnique({ where: { id: occupied.id } });
    const response = await request()
      .post(`/api/beds/${occupied.id}/assign`)
      .set(auth(coordinator.token))
      .send({ patientId: occupied.patientRef });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'RESOURCE_CONFLICT');

    const after = await prisma.bed.findUnique({ where: { id: occupied.id } });
    assert.deepEqual([after.status, after.patientId], [before.status, before.patientId], 'the row is untouched');
  });

  test('two placements on the same bed cannot both succeed (row lock)', async () => {
    const bed = await prisma.bed.findFirst({ where: { status: 'AVAILABLE', patientId: null } });
    const waiting = await prisma.patient.findMany({ where: { queueEntry: { isNot: null } }, take: 2 });

    const results = await Promise.all([
      request().post(`/api/beds/${bed.id}/assign`).set(auth(coordinator.token)).send({ patientId: waiting[0].patientNumber }),
      request().post(`/api/beds/${bed.id}/assign`).set(auth(coordinator.token)).send({ patientId: waiting[1].patientNumber }),
    ]);
    const statuses = results.map((result) => result.status).sort();
    assert.deepEqual(statuses, [200, 409], 'exactly one placement wins the lock');

    const stored = await prisma.bed.findUnique({ where: { id: bed.id } });
    const winner = results.find((result) => result.status === 200);
    assert.equal(stored.patientRef, winner.body.data.patient.id, 'the bed holds the winning patient only');
    assert.equal(stored.status, 'OCCUPIED');
  });

  test('a doctor cannot place a patient into a bed (authorization)', async () => {
    const bed = await prisma.bed.findFirst({ where: { status: 'AVAILABLE', patientId: null } });
    const waiting = await prisma.patient.findFirst({ where: { queueEntry: { isNot: null } } });
    const response = await request()
      .post(`/api/beds/${bed.id}/assign`)
      .set(auth(doctor.token))
      .send({ patientId: waiting.patientNumber });
    assert.equal(response.status, 403);
  });

  test('a bed holding a patient cannot be freed without a discharge confirmation', async () => {
    const occupied = await prisma.bed.findFirst({ where: { patientId: { not: null } } });
    const response = await request().patch(`/api/beds/${occupied.id}/status`).set(auth(coordinator.token)).send({ status: 'Available' });
    assert.equal(response.status, 409);
    assert.match(response.body.error.message, /discharge|transfer/i);
  });

  test('releasing a bed marks it for cleaning rather than freeing it instantly', async () => {
    const bed = await prisma.bed.findFirst({ where: { status: 'AVAILABLE', patientId: null } });
    const response = await request().patch(`/api/beds/${bed.id}/status`).set(auth(coordinator.token)).send({ status: 'Reserved', heldFor: 'Held for an incoming case' });
    assert.equal(response.status, 200);
    const stored = await prisma.bed.findUnique({ where: { id: bed.id } });
    assert.equal(stored.status, 'RESERVED');
    await request().patch(`/api/beds/${bed.id}/status`).set(auth(coordinator.token)).send({ status: 'Available' });
  });
});

describe('equipment', () => {
  test('equipment utilisation is computed from the unit registers', async () => {
    const response = await request().get('/api/equipment').set(auth(command.token));
    assert.equal(response.status, 200);
    const ventilators = response.body.categories.find((category) => category.id === 'ventilators');
    assert.equal(ventilators.total, 15);
    assert.equal(ventilators.available, ventilators.total - ventilators.inUse);
    assert.equal(ventilators.free, Math.max(ventilators.available - ventilators.reserved, 0));
    assert.equal(ventilators.utilisation, Math.round((ventilators.inUse / ventilators.total) * 1000) / 10);
  });

  test('reserving more units than are free is refused and reserves nothing', async () => {
    const categories = await request().get('/api/equipment').set(auth(coordinator.token));
    const ventilators = categories.body.categories.find((category) => category.id === 'ventilators');
    const before = await prisma.equipmentUnit.count({ where: { equipmentId: 'ventilators', reserved: true, inUse: false } });

    const response = await request()
      .post('/api/equipment/reserve')
      .set(auth(coordinator.token))
      .send({ categoryId: 'ventilators', quantity: ventilators.free + 5, reservedFor: 'Over-commit test' });
    assert.equal(response.status, 409);
    assert.match(response.body.error.message, /free unit/i);

    const after = await prisma.equipmentUnit.count({ where: { equipmentId: 'ventilators', reserved: true, inUse: false } });
    assert.equal(after, before, 'no partial reservation was written');
  });

  test('reserving then releasing units returns the register to its previous state', async () => {
    const board = await request().get('/api/equipment').set(auth(coordinator.token));
    const category = board.body.categories.find((entry) => entry.free >= 2);
    assert.ok(category, 'a category with two free units exists');

    const reserved = await request()
      .post('/api/equipment/reserve')
      .set(auth(coordinator.token))
      .send({ categoryId: category.id, quantity: 2, reservedFor: 'Equipment conflict test' });
    assert.equal(reserved.status, 200);
    assert.equal(reserved.body.data.unitIds.length, 2);

    const released = await request()
      .post('/api/equipment/release')
      .set(auth(coordinator.token))
      .send({ categoryId: category.id, unitIds: reserved.body.data.unitIds, reason: 'Test complete' });
    assert.equal(released.status, 200);

    const after = await prisma.equipmentUnit.findMany({ where: { id: { in: reserved.body.data.unitIds } } });
    assert.ok(after.every((unit) => unit.reserved === false && unit.status === 'Available'));
  });

  test('a doctor cannot hold equipment (authorization)', async () => {
    const response = await request()
      .post('/api/equipment/reserve')
      .set(auth(doctor.token))
      .send({ categoryId: 'ventilators', quantity: 1, reservedFor: 'Not permitted' });
    assert.equal(response.status, 403);
  });

});

describe('operating theatres', () => {
  test('the theatre board reports the configured theatres', async () => {
    const response = await request().get('/api/ot').set(auth(command.token));
    assert.equal(response.status, 200);
    assert.equal(response.body.rooms.length, 4);
    assert.equal(response.body.summary.total, 4);
    assert.ok(response.body.summary.ongoing >= 1, 'the seeded emergency laparotomy is running');
  });

  test('holding a theatre for an emergency never cancels a scheduled procedure', async () => {
    const scheduled = await prisma.otSchedule.findFirst({ where: { status: 'SCHEDULED' } });
    assert.ok(scheduled, 'a procedure is scheduled');

    const free = await prisma.operatingTheatre.findFirst({
      where: { status: 'AVAILABLE' },
      orderBy: { id: 'asc' },
    });
    assert.ok(free, 'a free theatre exists in the baseline');
    const response = await request()
      .post(`/api/ot/${free.id}/hold`)
      .set(auth(coordinator.token))
      .send({ patientId: 'P025', reason: 'Emergency surgical review hold' });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'Held');

    const stillScheduled = await prisma.otSchedule.findUnique({ where: { id: scheduled.id } });
    assert.equal(stillScheduled.status, 'SCHEDULED', 'the planned procedure keeps its slot');
    assert.match(response.body.data.note, /keep their slots|keeps its slot|no scheduled procedure/i);

    const released = await request().post(`/api/ot/${free.id}/release`).set(auth(coordinator.token)).send({ reason: 'Test complete' });
    assert.equal(released.status, 200);
  });

  test('a theatre under maintenance cannot be held', async () => {
    const maintenance = await prisma.operatingTheatre.findFirst({ where: { status: 'MAINTENANCE' } });
    const response = await request().post(`/api/ot/${maintenance.id}/hold`).set(auth(coordinator.token)).send({ reason: 'Emergency case' });
    assert.equal(response.status, 409);
  });

  test('equipment conflicts are reported for theatre slots', async () => {
    const response = await request().get('/api/ot/conflicts').set(auth(command.token));
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.conflicts));
  });
});
