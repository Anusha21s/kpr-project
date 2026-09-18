#!/usr/bin/env node
/**
 * MediCore — database seed.
 *
 * Idempotent: safe to run repeatedly (`npm run seed`). It upserts the roster,
 * facilities, patients, queue, theatre list, tasks, alerts and notifications,
 * and assigns the demo doctor/nurse accounts a realistic patient list so the
 * clinical dashboards are personalised from the first sign-in.
 */

const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const { ROLES } = require('../seeds/roles');
const { ACCOUNTS, buildDoctors, buildNurses } = require('../seeds/staff');
const { buildBeds, buildEquipment, buildEmergencyResources, buildTheatres, OT_BACKLOG } = require('../seeds/facilities');
const { INPATIENTS, QUEUE_PATIENTS, SURGE_PATIENTS } = require('../seeds/patients');
const { TASKS } = require('../seeds/tasks');
const { NURSE_WORKLOAD_LIMIT } = require('../seeds/constants');

const prisma = new PrismaClient();
const DEMO_PASSWORD = process.env.SEED_PASSWORD || 'demo123';
const today = () => {
  const date = new Date();
  date.setHours(8, 0, 0, 0);
  return date;
};

/**
 * Returns the operational tables to a clean baseline before the demo state is
 * written.
 *
 * Without this a second `npm run seed` after a demo would leave a patient
 * occupying a bed *and* sitting in the waiting queue, which is a contradictory
 * state: the placement logic would then try to place them twice and the
 * allocation transaction would fail. A seed must be able to rebuild a
 * believable hospital from whatever the last run left behind.
 */
async function resetOperationalState() {
  const removed = {
    allocations: (await prisma.allocation.deleteMany({})).count,
    recommendations: (await prisma.optimizationRecommendation.deleteMany({})).count,
    runs: (await prisma.optimizationRun.deleteMany({})).count,
    approvals: (await prisma.approval.deleteMany({})).count,
    simulations: (await prisma.surgeSimulation.deleteMany({})).count,
  };

  await prisma.patientQueue.deleteMany({});
  await prisma.clinicalTask.deleteMany({});
  await prisma.alert.deleteMany({});
  await prisma.notification.deleteMany({});
  await prisma.arrivalLog.deleteMany({});

  /* Simulated intake and any patient registered during a demo run are removed;
     the seeded roster of patients is rebuilt below. */
  await prisma.patient.deleteMany({ where: { isSimulated: true } });
  await prisma.patient.deleteMany({ where: { patientNumber: { notIn: [...INPATIENTS, ...QUEUE_PATIENTS, ...SURGE_PATIENTS].map((entry) => entry.patientNumber) } } });

  /* Every bed starts unoccupied; seedBeds() and seedPatients() then rebuild the
     configured occupancy picture from the seed constants. */
  const cleared = await prisma.bed.updateMany({ data: { patientId: null, heldFor: null, availableFrom: null, patientRef: null } });

  console.log(`  reset            ${removed.allocations} allocation(s), ${removed.runs} optimizer run(s), ${cleared.count} bed(s) cleared`);
}

async function seedRoles() {
  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { code: role.code },
      update: { label: role.label, description: role.description, permissions: role.permissions },
      create: role,
    });
  }
  console.log(`  roles            ${ROLES.length}`);
}

async function seedUsers() {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  for (const account of ACCOUNTS) {
    await prisma.user.upsert({
      where: { staffId: account.staffId },
      update: {
        staffRef: account.staffRef,
        name: account.name,
        title: account.title,
        roleCode: account.roleCode,
        department: account.department,
      },
      create: { ...account, passwordHash: hash },
    });
  }
  console.log(`  users            ${ACCOUNTS.length} (password: ${DEMO_PASSWORD})`);
}

async function seedDoctors() {
  const doctors = buildDoctors();
  for (const doctor of doctors) {
    const account = ACCOUNTS.find((entry) => entry.staffRef === doctor.id);
    const user = account ? await prisma.user.findUnique({ where: { staffId: account.staffId } }) : null;
    await prisma.doctor.upsert({
      where: { id: doctor.id },
      update: { ...doctor, userId: user ? user.id : null },
      create: { ...doctor, userId: user ? user.id : null },
    });
    if (doctor.shiftBlock) {
      await prisma.doctorDuty.upsert({
        where: { doctorId_shiftBlock_dutyDate: { doctorId: doctor.id, shiftBlock: doctor.shiftBlock, dutyDate: today() } },
        update: { status: doctor.dutyStatus, shiftLabel: doctor.shift },
        create: {
          doctorId: doctor.id,
          shiftBlock: doctor.shiftBlock,
          shiftLabel: doctor.shift,
          dutyDate: today(),
          status: doctor.dutyStatus,
        },
      });
    }
  }
  console.log(`  doctors          ${doctors.length}`);
}

async function seedNurses() {
  const nurses = buildNurses();
  for (const nurse of nurses) {
    const account = ACCOUNTS.find((entry) => entry.staffRef === nurse.id);
    const user = account ? await prisma.user.findUnique({ where: { staffId: account.staffId } }) : null;
    const payload = { ...nurse, userId: user ? user.id : null };
    delete payload.loginStaffId;
    await prisma.nurse.upsert({
      where: { id: nurse.id },
      update: payload,
      create: payload,
    });
    if (nurse.shiftBlock) {
      await prisma.nurseDuty.upsert({
        where: { nurseId_shiftBlock_dutyDate: { nurseId: nurse.id, shiftBlock: nurse.shiftBlock, dutyDate: today() } },
        update: { status: nurse.dutyStatus, shiftLabel: nurse.shift },
        create: {
          nurseId: nurse.id,
          shiftBlock: nurse.shiftBlock,
          shiftLabel: nurse.shift,
          dutyDate: today(),
          status: nurse.dutyStatus,
        },
      });
    }
  }
  console.log(`  nurses           ${nurses.length}`);
}

async function seedBeds() {
  const beds = buildBeds();
  for (const bed of beds) {
    const { id, ...rest } = bed;
    await prisma.bed.upsert({ where: { id }, update: rest, create: bed });
  }
  console.log(`  beds             ${beds.length}`);
}

async function seedEquipment() {
  const categories = buildEquipment();
  for (const category of categories) {
    const { units, unitsPrefix, ...rest } = category;
    await prisma.equipment.upsert({ where: { id: category.id }, update: rest, create: rest });
    for (const unit of units) {
      await prisma.equipmentUnit.upsert({
        where: { id: unit.id },
        update: { ...unit, equipmentId: category.id },
        create: { ...unit, equipmentId: category.id },
      });
    }
  }
  console.log(`  equipment        ${categories.length} categories`);
}

async function seedEmergencyResources() {
  const resources = buildEmergencyResources();
  for (const resource of resources) {
    const { id, ...rest } = resource;
    await prisma.emergencyResource.upsert({ where: { id }, update: rest, create: resource });
  }
  console.log(`  emergency res.   ${resources.length}`);
}

async function seedTheatres() {
  const theatres = buildTheatres();
  for (const theatre of theatres) {
    const { schedule, id, ...rest } = theatre;
    await prisma.operatingTheatre.upsert({ where: { id }, update: rest, create: { id, ...rest } });
    if (schedule && schedule.patientRef) {
      const patient = await prisma.patient.findUnique({ where: { patientNumber: schedule.patientRef } });
      const existing = await prisma.otSchedule.findFirst({ where: { theatreId: id } });
      const payload = {
        theatreId: id,
        patientId: patient ? patient.id : null,
        patientLabel: schedule.patientLabel,
        procedure: schedule.procedure,
        priority: schedule.priority,
        status: schedule.status,
        start: schedule.start,
        end: schedule.end,
        startMinutes: schedule.startMinutes,
        endMinutes: schedule.endMinutes,
        surgeonId: schedule.surgeonId,
        surgeonName: schedule.surgeonName,
        anaesthetist: schedule.anaesthetist,
        requiredEquipment: schedule.requiredEquipment,
        equipmentReady: schedule.equipmentReady,
        nurses: schedule.nurses,
        notes: schedule.notes,
        conflict: Boolean(schedule.conflict),
      };
      if (existing) await prisma.otSchedule.update({ where: { id: existing.id }, data: payload });
      else await prisma.otSchedule.create({ data: payload });
    }
  }
  console.log(`  theatres         ${theatres.length}`);
}

async function seedPatients() {
  /* ---------------------------------------------------------- inpatients */
  for (const inpatient of INPATIENTS) {
    const { bedId, tasks, ...rest } = inpatient;
    const patient = await prisma.patient.upsert({
      where: { patientNumber: inpatient.patientNumber },
      update: { ...rest, assignedBedId: bedId, isSimulated: false },
      create: { ...rest, assignedBedId: bedId },
    });
    await prisma.bed.update({
      where: { id: bedId },
      data: { patientId: patient.id, patientRef: inpatient.patientNumber, status: 'OCCUPIED', heldFor: null },
    });
    for (const taskTitle of tasks || []) {
      const existing = await prisma.clinicalTask.findFirst({ where: { patientNumber: inpatient.patientNumber, title: taskTitle } });
      if (!existing) {
        await prisma.clinicalTask.create({
          data: {
            reference: `TSK-${inpatient.patientNumber}-${taskTitle.slice(0, 8).replace(/\s+/g, '')}`,
            title: taskTitle,
            detail: `${taskTitle} for ${inpatient.patientNumber} (${inpatient.bedId}).`,
            category: 'Monitoring',
            priority: inpatient.priority,
            dueTime: 'Per shift',
            department: inpatient.department,
            patientNumber: inpatient.patientNumber,
            assignedDoctorId: inpatient.assignedDoctorId,
            assignedNurseId: inpatient.assignedNurseId,
          },
        });
      }
    }
  }
  console.log(`  patients         ${INPATIENTS.length} inpatients`);

  /* ------------------------------------------------------ emergency queue */
  /* A patient is either waiting or bedded, never both. */
  const queuedNumbers = QUEUE_PATIENTS.map((entry) => entry.patientNumber);
  await prisma.patientQueue.deleteMany({ where: { patient: { patientNumber: { notIn: queuedNumbers } } } });

  for (const queued of QUEUE_PATIENTS) {
    const { waitingMinutes, ...patientFields } = queued;
    const patient = await prisma.patient.upsert({
      where: { patientNumber: queued.patientNumber },
      update: { ...patientFields, isSimulated: false },
      create: { ...patientFields, isSimulated: false },
    });
    const waitingSince = new Date(Date.now() - waitingMinutes * 60 * 1000);
    await prisma.patientQueue.upsert({
      where: { patientId: patient.id },
      update: {
        status: 'WAITING',
        waitingMinutes,
        waitingSince,
        priority: queued.priority,
        triage: queued.triage,
        requiredResource: queued.requiredResource,
        secondaryResource: queued.secondaryResource,
      },
      create: {
        patientId: patient.id,
        status: 'WAITING',
        waitingMinutes,
        waitingSince,
        priority: queued.priority,
        triage: queued.triage,
        requiredResource: queued.requiredResource,
        secondaryResource: queued.secondaryResource,
        securedResources: [],
      },
    });
  }
  console.log(`  queue            ${QUEUE_PATIENTS.length} waiting`);

  /* ---------------------------------------------------- emergency arrivals */
  /* The demand models read arrival *flow* (patients per hour), which the waiting
     list alone cannot describe. The last 24 hours are seeded with the same
     hour-of-day rhythm the hospital actually experiences — quiet early morning,
     a late-afternoon and evening peak — and the currently waiting patients are
     logged with the times they really arrived, so the rolling counts agree with
     the queue on screen. */
  await prisma.arrivalLog.deleteMany({});
  const arrivalRows = [];
  const arrivalSources = ['AMBULANCE', 'WALK_IN', 'WALK_IN', 'REFERRAL', 'AMBULANCE', 'TRANSFER'];
  const seedingRng = () => Math.random();

  for (const queued of QUEUE_PATIENTS) {
    arrivalRows.push({
      patientId: null,
      patientNumber: queued.patientNumber,
      source: queued.priority === 'Critical' ? 'AMBULANCE' : arrivalSources[Math.floor(seedingRng() * arrivalSources.length)],
      priority: queued.priority,
      department: queued.department || 'Emergency',
      triage: queued.triage || 'ESI 3',
      arrivedAt: new Date(Date.now() - queued.waitingMinutes * 60 * 1000),
    });
  }

  /* Hourly arrival rate by hour of day (index 0 = midnight) — the hospital's
     own intake rhythm, used here so the seeded flow looks like the ward's. */
  const HOURLY_RATE = [7, 6, 5, 5, 6, 8, 10, 12, 13, 12, 11, 11, 12, 13, 14, 14, 13, 12, 13, 14, 13, 11, 9, 8];
  const startOfCurrentHour = new Date();
  startOfCurrentHour.setMinutes(0, 0, 0);

  for (let hoursAgo = 1; hoursAgo <= 24; hoursAgo += 1) {
    const slotStart = new Date(startOfCurrentHour.getTime() - hoursAgo * 60 * 60 * 1000);
    const hourOfDay = slotStart.getHours();
    const expected = HOURLY_RATE[hourOfDay];
    const count = Math.max(1, Math.round(expected + (seedingRng() - 0.5) * 3));
    for (let index = 0; index < count; index += 1) {
      const offsetMinutes = Math.floor(seedingRng() * 60);
      const priorityRoll = seedingRng();
      const priority = priorityRoll > 0.93 ? 'Critical' : priorityRoll > 0.72 ? 'High' : priorityRoll > 0.28 ? 'Medium' : 'Low';
      arrivalRows.push({
        patientId: null,
        patientNumber: null,
        source: arrivalSources[Math.floor(seedingRng() * arrivalSources.length)],
        priority,
        department: 'Emergency',
        triage: priority === 'Critical' ? 'ESI 1' : priority === 'High' ? 'ESI 2' : priority === 'Medium' ? 'ESI 3' : 'ESI 4',
        arrivedAt: new Date(slotStart.getTime() + offsetMinutes * 60 * 1000),
      });
    }
  }

  await prisma.arrivalLog.createMany({ data: arrivalRows });
  console.log(`  arrivals         ${arrivalRows.length} registrations logged (24 h)`);

  /* ------------------------------------------------------- clinical tasks */
  for (const task of TASKS) {
    const { reference, ...rest } = task;
    await prisma.clinicalTask.upsert({
      where: { reference },
      update: rest,
      create: { reference, ...rest },
    });
  }
  console.log(`  clinical tasks   ${TASKS.length}`);

  /* ------------------------------------------ theatre backlog (as alerts) */
  for (const request of OT_BACKLOG) {
    const patient = request.patientNumber
      ? await prisma.patient.findUnique({ where: { patientNumber: request.patientNumber } })
      : null;
    await prisma.alert.upsert({
      where: { reference: `ALR-${request.id}` },
      update: {},
      create: {
        reference: `ALR-${request.id}`,
        type: 'Operational',
        severity: 'HIGH',
        category: 'Theatre',
        title: `Surgical request awaiting a slot — ${request.procedure}`,
        description: `${request.surgeon} · priority ${request.priority}. Theatre scheduling review required.`,
        resource: 'OT',
        affectedResource: request.patientLabel,
        actionLabel: 'Review theatre schedule',
        actionTo: '/resources/ot',
        source: 'Theatre scheduling',
        status: 'ACTIVE',
        patientId: patient ? patient.id : null,
      },
    });
  }

  /* ------------------------------------------------------------- alerts */
  const alertSeeds = [
    {
      reference: 'ALR-ICU-01', type: 'Critical', severity: 'CRITICAL', category: 'Capacity',
      title: 'ICU capacity critical',
      description: 'ICU bed availability is at the configured threshold with ICU-level requests waiting in the emergency queue.',
      resource: 'ICU', affectedResource: 'ICU Bed', actionLabel: 'Open ICU allocation', actionTo: '/command/beds', source: 'Constraint engine',
    },
    {
      reference: 'ALR-QUEUE-01', type: 'Critical', severity: 'CRITICAL', category: 'Queue',
      title: 'Emergency queue above threshold',
      description: 'Critical-priority patients are waiting for ICU-level placement.',
      resource: 'Emergency queue', affectedResource: 'Emergency queue', actionLabel: 'Open patient queue', actionTo: '/command/queue', source: 'Constraint engine',
    },
    {
      reference: 'ALR-VENT-01', type: 'Operational', severity: 'HIGH', category: 'Equipment',
      title: 'Ventilator availability under pressure',
      description: 'Ventilator demand from the emergency queue is close to the free unit count.',
      resource: 'Ventilators', affectedResource: 'Ventilator', actionLabel: 'Open equipment', actionTo: '/command/equipment', source: 'Constraint engine',
    },
    {
      reference: 'ALR-WORK-01', type: 'Operational', severity: 'OPERATIONAL', category: 'Workload',
      title: 'Nursing workload at the configured limit',
      description: 'Several nurses are at the configured workload constraint; deployment review required.',
      resource: 'Nursing', affectedResource: 'Nurse allocation', actionLabel: 'Open nurse allocation', actionTo: '/resources/nurses', source: 'Constraint engine',
    },
  ];
  for (const alert of alertSeeds) {
    await prisma.alert.upsert({ where: { reference: alert.reference }, update: {}, create: { ...alert, status: 'ACTIVE' } });
  }
  console.log(`  alerts           ${alertSeeds.length + OT_BACKLOG.length}`);

  /* ------------------------------------------------------ notifications */
  const commandUser = await prisma.user.findUnique({ where: { staffId: 'CMD001' } });
  const coordinator = await prisma.user.findUnique({ where: { staffId: 'RES001' } });
  const surgeon = await prisma.user.findUnique({ where: { staffId: 'DOC002' } });
  const icuNurse = await prisma.user.findUnique({ where: { staffId: 'NUR001' } });
  const multiResource = await prisma.patient.findUnique({ where: { patientNumber: 'P025' } });

  const notifications = [
    {
      userId: coordinator.id, title: 'ICU pressure needs a coordination decision',
      body: 'ICU vacancy is at the threshold while ICU-level requests are queued. Review the allocation options.',
      type: 'Critical', category: 'Capacity', actionLabel: 'Open ICU allocation', actionTo: '/resources/icu',
    },
    {
      userId: coordinator.id, title: 'Surgical requests awaiting a slot',
      body: 'Requests are waiting for an available theatre. Review scheduling before the next list.',
      type: 'Operational', category: 'Theatre', actionLabel: 'Open theatre scheduling', actionTo: '/resources/ot',
    },
    {
      userId: commandUser.id, title: 'ICU capacity critical',
      body: 'ICU bed availability is at the configured threshold with ICU-level requests waiting.',
      type: 'Critical', category: 'Capacity', actionLabel: 'Open bed capacity', actionTo: '/command/beds',
    },
    {
      userId: surgeon.id, title: 'Multi-resource emergency case recorded',
      body: 'P025 is waiting with ICU, theatre, ventilator and surgical support required together.',
      type: 'Critical', category: 'Assignment', patientId: multiResource ? multiResource.id : null,
      actionLabel: 'Open emergency cases', actionTo: '/clinical/emergency',
    },
    {
      userId: icuNurse.id, title: 'Assignment updated — ICU',
      body: 'Your ICU assignment list has been refreshed for this shift.',
      type: 'Operational', category: 'Assignment', actionLabel: 'Open my patients', actionTo: '/clinical/patients',
    },
    {
      userId: icuNurse.id, title: 'Ward workload at the configured limit',
      body: 'ICU nursing workload has reached the configured constraint. Escalate staffing requests if care is at risk.',
      type: 'Critical', category: 'Workload', actionLabel: 'Open my duty', actionTo: '/clinical/duty',
    },
  ];
  for (const notification of notifications) {
    if (!notification.userId) continue;
    const existing = await prisma.notification.findFirst({
      where: { userId: notification.userId, title: notification.title },
    });
    if (!existing) await prisma.notification.create({ data: notification });
  }
  console.log(`  notifications    ${notifications.length}`);

  /* -------------------------------------------------------- audit marker */
  await prisma.auditLog.create({
    data: {
      action: 'DATABASE_SEEDED',
      entity: 'Hospital',
      actorName: 'seed script',
      actorRole: 'system',
      after: { patients: INPATIENTS.length + QUEUE_PATIENTS.length, surgeBatch: SURGE_PATIENTS.length },
    },
  });
}

async function main() {
  console.log('MediCore seed — writing operational state\n');
  await resetOperationalState();
  await seedRoles();
  await seedUsers();
  await seedDoctors();
  await seedNurses();
  await seedBeds();
  await seedEquipment();
  await seedEmergencyResources();
  await seedTheatres();
  await seedPatients();

  const workload = await prisma.nurse.aggregate({ _avg: { assignedPatients: true }, _count: true });
  console.log(`\nSeed complete.`);
  console.log(`  nurses at limit  ${await prisma.nurse.count({ where: { assignedPatients: { gte: NURSE_WORKLOAD_LIMIT } } })}`);
  console.log(`  avg nurse load   ${workload._avg.assignedPatients.toFixed(1)} patients`);
  console.log(`\nDemo sign-in (role comes from the account):`);
  console.log('  CMD001 / demo123   Command Center');
  console.log('  RES001 / demo123   Resource Coordinator');
  console.log('  DOC001 / demo123   Doctor (Dr. Kumar — Cardiology)');
  console.log('  NUR001 / demo123   Nurse (Nurse Priya — ICU)');
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
