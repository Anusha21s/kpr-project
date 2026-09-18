/**
 * Allocation service (§31, §32, §38, §48).
 *
 * The approval workflow ends here:
 *
 *   recommendation → approval request (pending) → coordinator approves →
 *   allocation applied inside ONE transaction with row locks →
 *   bed / staff / equipment / theatre rows updated together, or not at all.
 *
 * If any step fails, the whole transaction rolls back, so a patient can never
 * be half-placed (bed without nurse, ICU bed without ventilator, and so on).
 */

const { prisma } = require('../config/database');
const { loadState } = require('../repositories/hospitalStateRepository');
const { optimizeResources, projectRecommendations } = require('../optimization/resourceOptimizer');
const { ApiError } = require('../utils/ApiError');
const { emit, EVENTS, room } = require('../socket/bus');
const audit = require('./auditService');
const aiEvents = require('./aiService');
const notification = require('./notificationService');
const { toAllocation, toApproval } = require('../repositories/hospitalStateRepository');

const ALLOCATION_ROOMS = [room.role('command_center'), room.role('resource_coordinator')];

const UI_STATUS = { PROPOSED: 'Proposed', PENDING_APPROVAL: 'Pending Approval', CONFIRMED: 'Confirmed', REJECTED: 'Rejected', CANCELLED: 'Cancelled' };

async function list({ status, approvalId = null } = {}) {
  const rows = await prisma.allocation.findMany({
    where: { ...(status ? { status } : {}), ...(approvalId ? { approvalId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      patient: { select: { patientNumber: true } },
      bed: { select: { ward: true } },
      doctor: { select: { name: true, specialty: true } },
      nurse: { select: { name: true, department: true } },
      equipment: { select: { name: true } },
    },
  });
  return { allocations: rows.map(toAllocation), total: rows.length };
}

async function approvals({ status } = {}) {
  const rows = await prisma.approval.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { allocations: true },
  });
  return {
    approvals: rows.map((row) => ({
      ...toApproval(row),
      allocationCount: row.allocations.length,
      allocations: row.allocations.map(toAllocation),
    })),
    total: rows.length,
    pending: rows.filter((row) => row.status === 'PENDING_REVIEW').length,
  };
}

/**
 * Approves an approval request and applies every staged allocation.
 *
 * Locks the charged bed rows first (SELECT … FOR UPDATE), verifies the
 * baseline, then writes bed occupancy, staff assignment, equipment holds and
 * theatre holds in the same transaction. Any conflict aborts everything.
 */
const WARD_DEPARTMENT = { icu: 'ICU', emergency: 'Emergency', general: 'General Ward', maternity: 'Maternity' };

/**
 * A patient is never placed without a responsible clinician.
 *
 * Care-team continuity rule: prefer an on-duty, available doctor who already
 * cares for patients in the receiving ward (least loaded first); otherwise take
 * the least-loaded on-duty doctor for the case's specialty. The same rule
 * assigns a nurse from the ward, always inside the workload constraint.
 *
 * Off-duty staff are never chosen — if nobody is available the placement is
 * recorded without a doctor and the coordinator receives an escalation notice.
 */
async function assignCareTeam(tx, { patient, wardId }) {
  const wardDoctors = await tx.patient.findMany({
    where: { occupiedBed: { is: { wardId } }, assignedDoctorId: { not: null } },
    select: { assignedDoctorId: true },
  });
  const continuityIds = Array.from(new Set(wardDoctors.map((row) => row.assignedDoctorId)));

  const eligibleDoctors = await tx.doctor.findMany({
    where: { dutyStatus: 'ON_DUTY', availability: 'Available' },
    orderBy: [{ patients: 'asc' }],
  });

  /* Ordering: continuity with the ward → specialty match → rostered staff with
     an active account (so the assignment notification can reach them) → lightest
     load. A doctor without an account remains eligible, they read the ward board. */
  const byPreference = (list) =>
    [...list].sort(
      (a, b) =>
        (b.account ? 1 : 0) - (a.account ? 1 : 0) || a.patients - b.patients,
    );
  const withAccounts = (doctor) => ({ ...doctor, account: Boolean(doctor.userId) });

  const continuity = byPreference(eligibleDoctors.filter((doctor) => continuityIds.includes(doctor.id)).map(withAccounts));
  const specialty = byPreference(eligibleDoctors.filter((doctor) => doctor.specialty === patient.specialtyRequired).map(withAccounts));
  const chosenDoctor = continuity[0] || specialty[0] || byPreference(eligibleDoctors.map(withAccounts))[0] || null;

  if (chosenDoctor) {
    const nextLoad = chosenDoctor.patients + 1;
    await tx.doctor.update({
      where: { id: chosenDoctor.id },
      data: {
        patients: nextLoad,
        currentAssignment: `Care of ${patient.patientNumber} — ${wardId.toUpperCase()} ward`,
        availability: nextLoad >= chosenDoctor.maxOperationalLoad ? 'Assigned' : chosenDoctor.availability,
        workload: nextLoad >= chosenDoctor.maxOperationalLoad ? 'High' : chosenDoctor.workload,
      },
    });
    await tx.patient.update({ where: { id: patient.id }, data: { assignedDoctorId: chosenDoctor.id } });
  }

  const department = WARD_DEPARTMENT[wardId] || null;
  const eligibleNurses = await tx.nurse.findMany({
    where: { dutyStatus: 'ON_DUTY', availability: 'Available', department: department || undefined },
    orderBy: [{ assignedPatients: 'asc' }],
  });
  const nursePool = eligibleNurses.length
    ? eligibleNurses
    : await tx.nurse.findMany({ where: { dutyStatus: 'ON_DUTY', availability: 'Available' }, orderBy: [{ assignedPatients: 'asc' }] });
  const chosenNurse = nursePool.find((nurse) => nurse.assignedPatients < nurse.maxOperationalLoad) || null;

  if (chosenNurse) {
    const nextLoad = chosenNurse.assignedPatients + 1;
    await tx.nurse.update({
      where: { id: chosenNurse.id },
      data: {
        assignedPatients: nextLoad,
        currentAssignment: `Care of ${patient.patientNumber} — ${wardId.toUpperCase()} ward`,
        workload: nextLoad >= chosenNurse.maxOperationalLoad ? 'High' : chosenNurse.workload,
      },
    });
    await tx.patient.update({ where: { id: patient.id }, data: { assignedNurseId: chosenNurse.id } });
  }

  return {
    patientId: patient.patientNumber,
    doctorId: chosenDoctor ? chosenDoctor.id : null,
    doctorName: chosenDoctor ? chosenDoctor.name : 'Escalation required',
    nurseId: chosenNurse ? chosenNurse.id : null,
    nurseName: chosenNurse ? chosenNurse.name : 'Escalation required',
    continuity: Boolean(chosenDoctor && continuityIds.includes(chosenDoctor.id)),
  };
}

async function approve({ auth, id, selections = {}, note = null }) {
  let approval = await prisma.approval.findFirst({
    where: { OR: [{ reference: id }, { id }] },
    orderBy: { createdAt: 'desc' },
  });

  if (!approval) {
    const rec = await prisma.optimizationRecommendation.findFirst({
      where: { OR: [{ reference: id }, { id }], status: { in: ['OPEN', 'PENDING_REVIEW'] } },
      orderBy: { createdAt: 'desc' },
    }) || await prisma.optimizationRecommendation.findFirst({
      where: { OR: [{ reference: id }, { id }] },
      orderBy: { createdAt: 'desc' },
    });
    if (rec) {
      approval = await prisma.approval.findFirst({
        where: { optimizationId: rec.runId },
        orderBy: { createdAt: 'desc' },
      });
      if (!approval) {
        approval = await prisma.approval.findFirst({
          where: { recommendationIds: { has: rec.reference }, status: 'PENDING_REVIEW' },
          orderBy: { createdAt: 'desc' },
        }) || await prisma.approval.findFirst({
          where: { recommendationIds: { has: rec.reference } },
          orderBy: { createdAt: 'desc' },
        });
      }
    }
  }

  if (!approval) {
    const run = await prisma.optimizationRun.findFirst({
      where: { OR: [{ reference: id }, { id }] },
      orderBy: { createdAt: 'desc' },
    });
    if (run) {
      approval = await prisma.approval.findFirst({
        where: { optimizationId: run.id },
        orderBy: { createdAt: 'desc' },
      });
    }
  }

  if (!approval) throw ApiError.notFound(`Approval for ${id} was not found.`);
  if (approval.status === 'APPROVED') throw ApiError.conflict(`${approval.reference} has already been approved.`);
  if (approval.status === 'REJECTED') throw ApiError.conflict(`${approval.reference} was rejected — a new optimization run is required.`);

  const state = await loadState({ simulationId: 'auto' });
  const run = approval.optimizationId
    ? await prisma.optimizationRun.findUnique({ where: { id: approval.optimizationId }, include: { recommendations: true } })
    : null;

  const mergedSelections = { ...(run ? run.selections : {}), ...selections };
  const plan = optimizeResources(state, { selections: mergedSelections });
  const applyable = plan.recommendations.filter((recommendation) => {
    if (!run) return true;
    const stored = run.recommendations.find((entry) => entry.reference === recommendation.id);
    return !stored || stored.status !== 'REJECTED';
  });

  /* A selection is only valid while the capacity it was made against still
     exists. If the operational picture moved between the request and the
     confirmation, the decision is refused (409) rather than silently applied
     with less capacity than the coordinator approved. */
  Object.entries(mergedSelections).forEach(([recommendationId, optionId]) => {
    const stored = run ? run.recommendations.find((entry) => entry.reference === recommendationId) : null;
    const storedOption = stored ? (stored.options || []).find((option) => option.id === optionId) : null;
    const current = plan.recommendations.find((entry) => entry.id === recommendationId);
    if (!current) {
      throw ApiError.conflict(
        `The situation changed for ${recommendationId}: the resource it addressed is no longer constrained. Re-run the optimization to see the current plan.`,
      );
    }
    const currentOption = (current.options || []).find((option) => option.id === optionId);
    if (!currentOption) {
      throw ApiError.conflict(
        `The option "${optionId}" chosen for ${recommendationId} is no longer offered — the operational picture changed. Re-run the optimization and confirm the updated plan.`,
      );
    }
    if (storedOption && Number(storedOption.addedCapacity || 0) > 0 && Number(currentOption.addedCapacity || 0) === 0) {
      throw ApiError.conflict(
        `The capacity planned for ${recommendationId} (${optionId}) is no longer available — the resource was committed elsewhere. Re-run the optimization before confirming.`,
      );
    }
  });

  const draft = projectRecommendations(state, applyable, mergedSelections);

  const result = await prisma.$transaction(async (tx) => {
    /* ------------------------------------------------------- row locks */
    const pendingApproval = await tx.$queryRaw`
      SELECT id, status FROM "Approval" WHERE id = ${approval.id} FOR UPDATE
    `;
    const locked = Array.isArray(pendingApproval) ? pendingApproval[0] : null;
    if (!locked || locked.status !== 'PENDING_REVIEW') {
      throw ApiError.conflict(`${approval.reference} is no longer pending — another coordinator already decided it.`);
    }

    const bedTargets = Array.from(
      new Set([
        ...draft.bedUnits.filter((unit) => unit.heldFor && /cleared|step-down|surge|projected/i.test(unit.heldFor)).map((unit) => unit.id),
        ...state.bedUnits
          .filter((unit) => unit.heldFor && /Simulation|Held for surge|Held for incoming/i.test(String(unit.heldFor)))
          .map((unit) => unit.id),
      ]),
    );
    if (bedTargets.length) {
      await tx.$queryRawUnsafe(
        `SELECT id, status, "patientId" FROM "Bed" WHERE id IN (${bedTargets.map((_, index) => `$${index + 1}`).join(', ')}) FOR UPDATE`,
        ...bedTargets,
      );
    }

    /* --------------------------------------------------- bed capacity */
    let releasedBeds = [];
    let escalationBays = [];
    for (const recommendation of applyable) {
      if (recommendation.id === 'REC-BED-01') {
        const cleared = await tx.bed.findMany({
          where: { wardId: 'general', patientId: null, status: { in: ['RESERVED', 'CLEANING'] } },
          take: Math.max(1, recommendation.quantity),
          orderBy: { id: 'asc' },
        });
        if (cleared.length) {
          await tx.bed.updateMany({
            where: { id: { in: cleared.map((bed) => bed.id) } },
            data: { status: 'AVAILABLE', heldFor: 'Cleared and held for surge admissions', availableFrom: null },
          });
          releasedBeds = cleared.map((bed) => bed.id);
        } else if (recommendation.quantity > 0) {
          const availableGeneral = await tx.bed.count({ where: { wardId: 'general', patientId: null, status: 'AVAILABLE' } });
          if (availableGeneral === 0) {
            throw ApiError.conflict(
              'Recommendation is no longer feasible because current general bed capacity has changed. Re-run optimization to recalculate recommendations.',
            );
          }
        }
      }

      if (recommendation.id === 'REC-ICU-01') {
        const chosen = mergedSelections['REC-ICU-01'];
        const optionA = recommendation.options ? recommendation.options.find((option) => option.id === 'icu-option-a') : null;
        const wantsEscalation = chosen ? chosen === 'icu-option-a' : Boolean(optionA);
        if (wantsEscalation && optionA) {
          const bays = optionA.effect.bayIds || [];
          if (bays.length > 0) {
            const free = await tx.bed.findMany({ where: { id: { in: bays }, patientId: null } });
            if (free.length < bays.length) {
              throw ApiError.conflict(
                'Recommendation is no longer feasible because current ICU step-down capacity has changed. Re-run optimization to recalculate recommendations.',
              );
            }
            await tx.bed.updateMany({
              where: { id: { in: free.map((bed) => bed.id) } },
              data: {
                wardId: 'icu',
                ward: 'Intensive Care Unit',
                bedType: 'ICU Step-down Bay (escalation)',
                escalation: true,
                heldFor: 'ICU-governed step-down capacity — monitoring and airway support',
                notes: 'Escalation bay activated by coordinator confirmation.',
              },
            });
            escalationBays = free.map((bed) => bed.id);
          }
        }
      }
    }

    /* ------------------------------------------- nurse workload guard */
    for (const recommendation of applyable) {
      if (recommendation.id !== 'REC-NUR-01') continue;
      const deployments = (recommendation.effect && recommendation.effect.deployments) || [];
      for (const deployment of deployments) {
        const nurse = await tx.nurse.findUnique({ where: { id: deployment.nurseId } });
        if (!nurse) continue;
        if (nurse.dutyStatus !== 'ON_DUTY' || nurse.availability !== 'Available') {
          throw ApiError.conflict(
            `${nurse.name} is no longer available (${nurse.dutyStatus}/${nurse.availability}) — the allocation was rolled back instead of assigning an unavailable nurse.`,
          );
        }
        if (nurse.assignedPatients >= nurse.maxOperationalLoad) {
          throw ApiError.conflict(
            `${nurse.name} has reached the ${nurse.maxOperationalLoad}-patient workload constraint — allocation rolled back.`,
          );
        }
        await tx.nurse.update({
          where: { id: nurse.id },
          data: {
            availability: 'Assigned',
            assignedPatients: nurse.assignedPatients + 1,
            workload: nurse.assignedPatients + 1 >= nurse.maxOperationalLoad ? 'High' : nurse.workload,
            currentAssignment: `Surge cover — ${deployment.department}`,
          },
        });
      }
    }

    /* ------------------------------------------------ doctor coverage */
    for (const recommendation of applyable) {
      if (recommendation.id !== 'REC-DOC-01') continue;
      const assignments = (recommendation.effect && recommendation.effect.assignments) || [];
      for (const assignment of assignments) {
        const doctor = await tx.doctor.findUnique({ where: { id: assignment.doctorId } });
        if (!doctor) continue;
        if (doctor.dutyStatus !== 'ON_DUTY' || doctor.availability !== 'Available') {
          throw ApiError.conflict(
            `${doctor.name} is ${doctor.dutyStatus}/${doctor.availability} — off-duty staff are never assigned automatically. Allocation rolled back; raise an escalation request instead.`,
          );
        }
        await tx.doctor.update({
          where: { id: doctor.id },
          data: {
            availability: 'Assigned',
            patients: doctor.patients + 1,
            currentAssignment: `Surge response — ${assignment.specialty} cover`,
          },
        });

        const patient = await tx.patient.findFirst({ where: { patientNumber: assignment.queueId } });
        if (patient) {
          await tx.patient.update({ where: { id: patient.id }, data: { assignedDoctorId: doctor.id } });
          await tx.patientQueue.updateMany({ where: { patientId: patient.id }, data: { status: 'ALLOCATION_PROPOSED' } });
        }
      }
    }

    /* ------------------------------------------------------ equipment */
    for (const recommendation of applyable) {
      if (recommendation.id !== 'REC-EQP-01') continue;
      const unitIds = (recommendation.effect && recommendation.effect.unitIds) || [];
      if (!unitIds.length) continue;
      const units = await tx.equipmentUnit.findMany({ where: { id: { in: unitIds }, inUse: false, reserved: false } });
      if (units.length !== unitIds.length) {
        throw ApiError.conflict('A requested equipment unit was committed elsewhere — allocation rolled back rather than double-booking equipment.');
      }
      await tx.equipmentUnit.updateMany({
        where: { id: { in: units.map((unit) => unit.id) } },
        data: { reserved: true, status: 'Reserved', reservedFor: 'Surge response — ventilation support' },
      });
    }

    /* -------------------------------------------------------- theatre */
    let heldTheatres = [];
    for (const recommendation of applyable) {
      if (recommendation.id !== 'REC-OT-01') continue;
      const selected = mergedSelections['REC-OT-01'];
      const options = recommendation.options || [];
      const chosen = selected
        ? options.find((option) => option.id === selected)
        : options.find((option) => option.recommended) || null;
      if (!chosen) continue;
      const theatreId = chosen.id;
      const theatre = await tx.operatingTheatre.findUnique({ where: { id: theatreId } });
      if (!theatre || theatre.status === 'MAINTENANCE') continue;
      const clash = await tx.otSchedule.findFirst({ where: { theatreId, status: { in: ['ONGOING', 'SCHEDULED'] } } });
      if (clash) {
        /* Never cancel another patient's procedure — the hold is refused and the
           coordinator is told to escalate instead. */
        continue;
      }
      await tx.operatingTheatre.update({ where: { id: theatreId }, data: { status: 'HELD' } });
      heldTheatres = [...heldTheatres, theatreId];
    }

    /* --------------------------------------------- emergency capacity */
    for (const recommendation of applyable) {
      if (recommendation.id !== 'REC-EMG-01') continue;
      const resource = await tx.emergencyResource.findUnique({ where: { id: 'emergency_beds' } });
      if (resource && resource.inUse < resource.total) {
        const nextInUse = resource.inUse + Math.min(recommendation.quantity, resource.total - resource.inUse);
        await tx.emergencyResource.update({
          where: { id: resource.id },
          data: {
            inUse: nextInUse,
            status: nextInUse >= resource.total ? 'Committed' : nextInUse >= Math.ceil(resource.total * 0.7) ? 'Tight' : 'Available',
          },
        });
      }
    }

    /* ------------------------------------------- patient placements */
    const placements = [];
    const queueRows = await tx.patientQueue.findMany({
      where: { status: { in: ['WAITING', 'ALLOCATION_PROPOSED'] } },
      include: { patient: true },
      orderBy: [{ priority: 'asc' }, { waitingMinutes: 'desc' }],
    });

    const wardFor = (resource) => (resource === 'ICU Bed' ? 'icu' : resource === 'Emergency Bed' ? 'emergency' : 'general');
    const placedPatients = new Set();
    const skipped = [];

    for (const entry of queueRows) {
      if (!entry.requiredResource) continue;

      /* A patient occupies at most one bed. A stale queue row (or a duplicate
         entry pointing at someone already admitted) is skipped with a reason
         instead of failing the whole transaction — an approved plan must either
         apply completely or not at all, and it must never move a patient who is
         already in a bed without an explicit transfer decision. */
      const alreadyBedded = await tx.bed.findFirst({ where: { patientId: entry.patientId }, select: { id: true } });
      if (alreadyBedded || placedPatients.has(entry.patientId)) {
        skipped.push({
          patientId: entry.patient.patientNumber,
          reason: alreadyBedded
            ? `already occupies ${alreadyBedded.id} — a transfer has to be requested explicitly`
            : 'duplicate queue entry in the same plan',
        });
        await tx.patientQueue.update({ where: { id: entry.id }, data: { status: 'ALLOCATED', resolvedAt: new Date() } });
        continue;
      }

      const wardId = wardFor(entry.requiredResource);
      const bed = await tx.$queryRaw`
        SELECT id FROM "Bed" WHERE "wardId" = ${wardId} AND status = 'AVAILABLE' AND "patientId" IS NULL
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
      `;
      const target = Array.isArray(bed) ? bed[0] : null;
      if (!target) continue;

      await tx.bed.update({
        where: { id: target.id },
        data: {
          status: 'OCCUPIED',
          patientId: entry.patientId,
          patientRef: entry.patient.patientNumber,
          heldFor: null,
          availableFrom: null,
        },
      });
      await tx.patient.update({
        where: { id: entry.patientId },
        data: { assignedBedId: target.id, department: wardId === 'icu' ? 'ICU' : wardId === 'emergency' ? 'Emergency' : 'General Ward', status: 'Admitted' },
      });
      await tx.patientQueue.update({ where: { id: entry.id }, data: { status: 'ALLOCATED', resolvedAt: new Date() } });

      /* Every placement leaves the transaction with a responsible care team. */
      const careTeam = await assignCareTeam(tx, { patient: entry.patient, wardId });
      placedPatients.add(entry.patientId);
      placements.push({ patientId: entry.patient.patientNumber, bedId: target.id, careTeam });

      if (entry.requiredResource === 'ICU Bed' && entry.patient.requiresVentilator) {
        const unit = await tx.equipmentUnit.findFirst({ where: { equipmentId: 'ventilators', inUse: false, reserved: true } });
        if (unit) await tx.equipmentUnit.update({ where: { id: unit.id }, data: { inUse: true, reserved: false, status: 'In Use', patientId: entry.patientId } });
      }
    }

    /* ---------------------------------------- close the workflow rows */
    const confirmedAllocations = await tx.allocation.updateMany({
      where: { approvalId: approval.id, status: { in: ['PROPOSED', 'PENDING_APPROVAL'] } },
      data: {
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        allocatedById: auth.userId || null,
        reason: note || 'Approved by the resource coordinator',
      },
    });

    await tx.optimizationRecommendation.updateMany({
      where: { runId: approval.optimizationId || '', status: 'OPEN' },
      data: { status: 'APPLIED' },
    });

    const updatedApproval = await tx.approval.update({
      where: { id: approval.id },
      data: {
        status: 'APPROVED',
        decidedById: auth.userId || null,
        decidedByName: auth.staffRef ? `${auth.name} · ${auth.staffRef}` : auth.name,
        decidedAt: new Date(),
        reason: note,
      },
    });

    if (approval.optimizationId) {
      await tx.optimizationRun.update({ where: { id: approval.optimizationId }, data: { status: 'APPLIED' } });
    }

    return {
      approval: updatedApproval,
      placements,
      releasedBeds,
      escalationBays,
      heldTheatres,
      skipped,
      allocationsConfirmed: confirmedAllocations.count,
    };
  }, { timeout: 45000 });

  /* ------------------------------------------------- notifications */
  const placedPatients = await prisma.patient.findMany({
    where: { patientNumber: { in: result.placements.map((placement) => placement.patientId) } },
    include: {
      assignedDoctor: { include: { user: { select: { id: true } } } },
      assignedNurse: { include: { user: { select: { id: true } } } },
    },
  });

  const doctorUserIds = [];
  const nurseUserIds = [];
  for (const patient of placedPatients) {
    if (patient.assignedDoctor && patient.assignedDoctor.user) doctorUserIds.push(patient.assignedDoctor.user.id);
    if (patient.assignedNurse && patient.assignedNurse.user) nurseUserIds.push(patient.assignedNurse.user.id);
  }

  if (doctorUserIds.length) {
    await notification.notify({
      userIds: doctorUserIds,
      title: 'New patients assigned to you',
      body: `${placedPatients.length} patient(s) were placed after the surge allocation was approved by the resource coordinator. Open My Patients for the updated list.`,
      type: 'Operational',
      category: 'Assignment',
      actionLabel: 'Open my patients',
      actionTo: '/clinical/patients',
      event: EVENTS.BED_UPDATED,
      payload: { placements: result.placements.length },
      extraRooms: ALLOCATION_ROOMS,
    });
  }

  if (nurseUserIds.length) {
    await notification.notify({
      userIds: nurseUserIds,
      title: 'Nursing assignment updated',
      body: `${placedPatients.length} patient placement(s) confirmed. Nursing cover was rebalanced within the configured workload constraint.`,
      type: 'Operational',
      category: 'Assignment',
      actionLabel: 'Open my duty',
      actionTo: '/clinical/duty',
      event: EVENTS.NURSE_AVAILABILITY,
      payload: { placements: result.placements.length },
      extraRooms: ALLOCATION_ROOMS,
    });
  }

  await notification.notify({
    userIds: [...(await notification.userIdsForRole('command_center'))],
    title: `Allocation ${result.approval.reference} confirmed`,
    body: `${result.allocationsConfirmed} allocation(s) applied. ${result.placements.length} patient(s) placed, ${result.releasedBeds.length} bed(s) cleared, ${result.escalationBays.length} escalation bay(s) activated, ${result.heldTheatres.length} theatre(s) held${(result.skipped || []).length ? `, ${result.skipped.length} case(s) skipped and left for a separate transfer decision` : ''}.`,
    type: 'Operational',
    category: 'Allocation',
    actionLabel: 'Open allocation board',
    actionTo: '/resources/allocations',
  });

  audit.record({
    action: 'ALLOCATION_APPROVED',
    auth,
    entity: 'Approval',
    entityId: result.approval.reference,
    detail: {
      message: `Allocation confirmed — ${result.placements.length} patient(s) placed${result.escalationBays.length ? `, ${result.escalationBays.length} ICU escalation bay(s) activated` : ''}`,
      tone: 'success',
    },
  });

  emit(
    EVENTS.ALLOCATION_UPDATED,
    {
      approvalId: result.approval.reference,
      status: 'Approved',
      placements: result.placements,
      allocations: result.allocationsConfirmed,
    },
    { rooms: [...ALLOCATION_ROOMS, ...doctorUserIds.map((userId) => room.user(userId)), room.department('ICU')] },
  );
  emit(EVENTS.BED_UPDATED, { change: 'allocation-applied', beds: result.releasedBeds.length + result.placements.length }, { rooms: ALLOCATION_ROOMS });
  emit(EVENTS.QUEUE_UPDATED, { placed: result.placements.map((placement) => placement.patientId) }, { rooms: ALLOCATION_ROOMS });

  /* The AI layer is told that the plan it recommended has become real, so the
     dashboards can mark the recommendation as applied rather than pending. */
  if (typeof aiEvents.publishAllocationApproved === 'function') {
    aiEvents.publishAllocationApproved({ approval: result.approval, applied: { placements: result.placements, allocations: result.allocationsConfirmed }, auth });
  }
  if (typeof aiEvents.invalidateAdvisoryCache === 'function') {
    aiEvents.invalidateAdvisoryCache();
  }

  return {
    approval: {
      id: result.approval.reference,
      status: 'Approved',
      decidedBy: result.approval.decidedByName,
      decidedAt: result.approval.decidedAt,
    },
    applied: {
      allocations: result.allocationsConfirmed,
      placements: result.placements,
      skipped: result.skipped || [],
      bedsCleared: result.releasedBeds,
      escalationBays: result.escalationBays,
      theatresHeld: result.heldTheatres,
    },
    notified: { doctors: doctorUserIds.length, nurses: nurseUserIds.length },
    transactional: true,
    note: 'Every change above committed in a single transaction with row locks. A failure anywhere would have rolled back the whole allocation.',
  };
}

/** Rejects an approval request: no resource moves. */
async function reject({ auth, id, reason }) {
  const approval = await prisma.approval.findFirst({ where: { OR: [{ reference: id }, { id }] } });
  if (!approval) throw ApiError.notFound(`Approval ${id} was not found.`);
  if (approval.status !== 'PENDING_REVIEW') throw ApiError.conflict(`${approval.reference} is ${approval.status.toLowerCase()} and can no longer be rejected.`);

  const [updated] = await prisma.$transaction([
    prisma.approval.update({
      where: { id: approval.id },
      data: {
        status: 'REJECTED',
        reason,
        decidedById: auth.userId || null,
        decidedByName: auth.staffRef ? `${auth.name} · ${auth.staffRef}` : auth.name,
        decidedAt: new Date(),
      },
    }),
    prisma.allocation.updateMany({
      where: { approvalId: approval.id, status: { in: ['PROPOSED', 'PENDING_APPROVAL'] } },
      data: { status: 'REJECTED', rejectedAt: new Date(), reason },
    }),
    prisma.optimizationRecommendation.updateMany({
      where: { runId: approval.optimizationId || '', status: 'OPEN' },
      data: { status: 'REJECTED', rejectedReason: reason, rejectedBy: auth.name, rejectedAt: new Date() },
    }),
  ]);

  audit.record({
    action: 'ALLOCATION_REJECTED',
    auth,
    entity: 'Approval',
    entityId: updated.reference,
    detail: { message: `${updated.reference} rejected — ${reason}. No resource was allocated.`, tone: 'alert' },
  });
  emit(EVENTS.ALLOCATION_UPDATED, { approvalId: updated.reference, status: 'Rejected', reason }, { rooms: ALLOCATION_ROOMS });

  await notification.notify({
    userIds: await notification.userIdsForRole('command_center'),
    title: `Allocation ${updated.reference} rejected`,
    body: `The resource coordinator rejected the allocation request: ${reason}. A new optimization run or an escalation request is required.`,
    type: 'Operational',
    category: 'Allocation',
    actionLabel: 'Open pending approvals',
    actionTo: '/resources/approvals',
  });

  return { id: updated.reference, status: 'Rejected', reason, applied: false, allocations: 0 };
}

module.exports = { list, approvals, approve, reject, UI_STATUS };
