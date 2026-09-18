/**
 * Assignment scoping — doctors and nurses only ever see their own patients (§47).
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { request, login, auth, prisma, disconnect } = require('./helpers');

let doctor;
let doctor2;
let nurse;
let command;

before(async () => {
  [doctor, doctor2, nurse, command] = await Promise.all([login('DOC001'), login('DOC002'), login('NUR001'), login('CMD001')]);
});

after(async () => {
  await disconnect();
});

describe('assignment scoping', () => {
  test('the command center sees the hospital-wide patient list', async () => {
    const response = await request().get('/api/patients').set(auth(command.token));
    assert.equal(response.status, 200);
    assert.equal(response.body.scope, 'hospital');
    assert.ok(response.body.total >= 12, 'at least the seeded inpatients are visible');
  });

  test('GET /api/patients/my returns only the signed-in doctor assignments', async () => {
    const response = await request().get('/api/patients/my').set(auth(doctor.token));
    assert.equal(response.status, 200);
    assert.equal(response.body.scope, 'own-assignments');
    assert.ok(response.body.patients.every((patient) => patient.assignedDoctors.includes(doctor.user.staffRef)));
  });

  test('two doctors never see each other’s patients', async () => {
    const [first, second] = await Promise.all([
      request().get('/api/patients/my').set(auth(doctor.token)),
      request().get('/api/patients/my').set(auth(doctor2.token)),
    ]);
    const firstIds = first.body.patients.map((patient) => patient.id);
    const secondIds = second.body.patients.map((patient) => patient.id);
    assert.equal(firstIds.some((id) => secondIds.includes(id)), false, 'the two lists do not overlap');
    assert.ok(second.body.patients.every((patient) => patient.assignedDoctors.includes(doctor2.user.staffRef)));
  });

  test('a doctor cannot open another doctor’s patient record', async () => {
    const other = await request().get('/api/patients/my').set(auth(doctor2.token));
    const target = other.body.patients[0];
    assert.ok(target, 'the second doctor holds at least one patient');

    const response = await request().get(`/api/patients/${target.id}`).set(auth(doctor.token));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FORBIDDEN');
  });

  test('a nurse only receives assigned patients and own tasks', async () => {
    const patients = await request().get('/api/patients/my').set(auth(nurse.token));
    assert.equal(patients.status, 200);
    assert.ok(patients.body.patients.every((patient) => patient.assignedNurses.includes(nurse.user.staffRef)));

    const tasks = await request().get('/api/tasks').set(auth(nurse.token));
    assert.equal(tasks.body.scope, 'own-assignments');
    assert.ok(tasks.body.tasks.every((task) => task.assignedNurseId === nurse.user.staffRef));
  });

  test('a nurse cannot complete another nurse’s task', async () => {
    const other = await prisma.clinicalTask.findFirst({
      where: { assignedNurseId: { not: nurse.user.staffRef }, status: 'Open' },
    });
    assert.ok(other, 'an unrelated nursing task exists');
    const response = await request().post(`/api/tasks/${other.reference}/complete`).set(auth(nurse.token)).send({});
    assert.equal(response.status, 403);
  });

  test('the patient list supports the filters the dashboards use', async () => {
    const response = await request().get('/api/patients?priority=Critical').set(auth(command.token));
    assert.equal(response.status, 200);
    assert.ok(response.body.patients.every((patient) => patient.priority === 'Critical'));
  });

  test('patient detail exposes the operational record for an authorised viewer', async () => {
    const mine = await request().get('/api/patients/my').set(auth(doctor.token));
    const response = await request().get(`/api/patients/${mine.body.patients[0].id}`).set(auth(doctor.token));
    assert.equal(response.status, 200);
    assert.equal(response.body.id, mine.body.patients[0].id);
    assert.ok('detail' in response.body && 'tasks' in response.body);
  });
});
