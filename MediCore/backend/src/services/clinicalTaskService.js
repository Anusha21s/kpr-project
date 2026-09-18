/**
 * Clinical task service (§40).
 *
 * Tasks belong to the clinician they were assigned to. Doctors and nurses only
 * see their own list; the command centre sees the operational aggregate without
 * expanding any patient record.
 */

const { prisma } = require('../config/database');
const { loadState } = require('../repositories/hospitalStateRepository');
const { ApiError } = require('../utils/ApiError');
const audit = require('./auditService');

const isClinical = (role) => role === 'doctor' || role === 'nurse';

const toTask = (task) => ({
  id: task.reference,
  dbId: task.id,
  title: task.title,
  detail: task.detail,
  category: task.category,
  priority: task.priority,
  dueTime: task.dueTime,
  department: task.department,
  patientId: task.patientNumber,
  patientNumber: task.patientNumber,
  assignedDoctorId: task.assignedDoctorId,
  assignedNurseId: task.assignedNurseId,
  status: task.status,
  note: task.note,
  completedAt: task.completedAt,
  completedBy: task.completedBy,
});

async function list({ auth, query = {} } = {}) {
  const state = await loadState({ simulationId: 'auto' });
  let tasks = Object.values(state.clinicalTasks);

  if (isClinical(auth.role)) {
    tasks =
      auth.role === 'doctor'
        ? Object.values(state.clinicalTasks).filter((task) => task.assignedDoctorId === auth.staffRef)
        : Object.values(state.clinicalTasks).filter((task) => task.assignedNurseId === auth.staffRef);
  }

  if (query.status) tasks = tasks.filter((task) => task.status === query.status);
  if (query.patientId) tasks = tasks.filter((task) => task.patientNumber === query.patientId);
  if (query.department) tasks = tasks.filter((task) => task.department === query.department);

  const rows = await prisma.clinicalTask.findMany({
    where: { reference: { in: tasks.map((task) => task.id) } },
    orderBy: [{ status: 'asc' }, { dueTime: 'asc' }],
  });

  return {
    tasks: rows.map(toTask),
    total: rows.length,
    open: rows.filter((task) => task.status !== 'Completed').length,
    completed: rows.filter((task) => task.status === 'Completed').length,
    scope: isClinical(auth.role) ? 'own-assignments' : 'department',
  };
}

async function complete({ auth, id, note = null }) {
  const task = await prisma.clinicalTask.findFirst({ where: { OR: [{ reference: id }, { id }] } });
  if (!task) throw ApiError.notFound(`Task ${id} was not found.`);

  if (isClinical(auth.role) && ![task.assignedDoctorId, task.assignedNurseId].includes(auth.staffRef)) {
    throw ApiError.forbidden('This task is assigned to another clinician.');
  }

  const updated = await prisma.clinicalTask.update({
    where: { id: task.id },
    data: {
      status: 'Completed',
      completedAt: new Date(),
      completedBy: auth.staffRef ? `${auth.name} · ${auth.staffRef}` : auth.name,
      note: note || task.note,
    },
  });

  audit.record({
    action: 'CLINICAL_TASK_COMPLETED',
    auth,
    entity: 'ClinicalTask',
    entityId: updated.reference,
    detail: { message: `${updated.reference} — ${updated.title} completed`, tone: 'success' },
  });

  return toTask(updated);
}

async function annotate({ auth, id, note }) {
  const task = await prisma.clinicalTask.findFirst({ where: { OR: [{ reference: id }, { id }] } });
  if (!task) throw ApiError.notFound(`Task ${id} was not found.`);
  if (isClinical(auth.role) && ![task.assignedDoctorId, task.assignedNurseId].includes(auth.staffRef)) {
    throw ApiError.forbidden('This task is assigned to another clinician.');
  }

  const updated = await prisma.clinicalTask.update({ where: { id: task.id }, data: { note } });
  audit.record({
    action: 'CLINICAL_TASK_ANNOTATED',
    auth,
    entity: 'ClinicalTask',
    entityId: updated.reference,
    detail: { message: `Clinical note recorded against ${updated.reference}`, tone: 'info' },
  });
  return toTask(updated);
}

module.exports = { list, complete, annotate, toTask };
