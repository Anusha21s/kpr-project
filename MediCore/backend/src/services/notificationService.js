/**
 * Notification service (§41, §46).
 *
 * Notifications are persisted per user so nothing is lost while a doctor or
 * nurse is away from the screen, and the same rows back the notification panel
 * after a reconnect. They are strictly user-scoped: one user can never read
 * another user's queue of notifications.
 */

const { prisma } = require('../config/database');
const { emit, room, EVENTS } = require('../socket/bus');
const { ApiError } = require('../utils/ApiError');

const toNotification = (row) => ({
  id: row.id,
  title: row.title,
  body: row.body,
  description: row.body,
  type: row.type,
  category: row.category,
  patientId: row.patient ? row.patient.patientNumber : null,
  patientDbId: row.patientId,
  action: row.actionLabel ? { label: row.actionLabel, to: row.actionTo } : null,
  read: Boolean(row.readAt),
  readAt: row.readAt,
  timestamp: row.createdAt,
  createdAt: row.createdAt,
});

/**
 * Creates one notification. `notify` accepts a single user id or a list.
 * The associated realtime event is the one that describes the operational
 * change (`allocation:updated`, `bed:updated`, …) so clients refresh the
 * affected dashboards; the persisted rows carry the message itself.
 */
async function notify({
  userIds,
  title,
  body,
  type = 'Operational',
  category = 'Operations',
  patientId = null,
  actionLabel = null,
  actionTo = null,
  event = null,
  payload = null,
  extraRooms = [],
}) {
  const targets = Array.from(new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean)));
  if (!targets.length) return [];

  const users = await prisma.user.findMany({ where: { id: { in: targets }, isActive: true }, select: { id: true } });
  if (!users.length) return [];

  const created = await prisma.$transaction(
    users.map((user) =>
      prisma.notification.create({
        data: { userId: user.id, title, body, type, category, patientId, actionLabel, actionTo },
        include: { patient: { select: { patientNumber: true } } },
      }),
    ),
  );

  if (event) {
    emit(event, payload || { title, category }, {
      rooms: [...users.map((user) => room.user(user.id)), ...extraRooms],
    });
  }

  return created.map(toNotification);
}

/** Users that a role-scoped notification should reach. */
async function userIdsForRole(roleCode) {
  const users = await prisma.user.findMany({ where: { roleCode, isActive: true }, select: { id: true } });
  return users.map((user) => user.id);
}

async function userIdsForStaffRefs(staffRefs = []) {
  if (!staffRefs.length) return [];
  const users = await prisma.user.findMany({
    where: { staffRef: { in: staffRefs }, isActive: true },
    select: { id: true },
  });
  return users.map((user) => user.id);
}

/** Current user's notifications — newest first, with an unread count. */
async function listForUser(userId, { unreadOnly = false, limit = 50 } = {}) {
  const rows = await prisma.notification.findMany({
    where: { userId, ...(unreadOnly ? { readAt: null } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(limit) || 50, 200),
    include: { patient: { select: { patientNumber: true } } },
  });
  const unread = await prisma.notification.count({ where: { userId, readAt: null } });
  return { notifications: rows.map(toNotification), unread, total: rows.length };
}

const markRead = async (userId, id) => {
  const existing = await prisma.notification.findFirst({ where: { id, userId } });
  /* Notifications are user-scoped: another user's row does not exist for you. */
  if (!existing) throw ApiError.notFound('That notification was not found for this account.');
  const updated = await prisma.notification.update({
    where: { id },
    data: { readAt: existing.readAt || new Date() },
    include: { patient: { select: { patientNumber: true } } },
  });
  return toNotification(updated);
};

const markAllRead = async (userId) => {
  const result = await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  return { updated: result.count };
};

/** Called after a patient is placed so the receiving staff member knows. */
async function notifyAssignment({ userIds, patient, summary, event, payload, extraRooms, actionTo }) {
  return notify({
    userIds,
    title: `New assignment — ${patient.patientNumber}`,
    body: summary,
    type: 'Operational',
    category: 'Assignment',
    patientId: patient.id,
    actionLabel: 'Open my patients',
    actionTo: actionTo || '/clinical/patients',
    event,
    payload,
    extraRooms,
  });
}

module.exports = {
  notify,
  listForUser,
  markRead,
  markAllRead,
  userIdsForRole,
  userIdsForStaffRefs,
  notifyAssignment,
  toNotification,
  EVENTS,
};
