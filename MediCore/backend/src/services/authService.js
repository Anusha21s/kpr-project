/**
 * Authentication service (§12, §13).
 *
 * The role comes from the account record, never from the client: a login body
 * carries a staff id and a password, nothing else. Passwords are compared
 * against bcrypt hashes and the JWT carries the role, staff reference and
 * permissions the API then enforces.
 */

const bcrypt = require('bcryptjs');
const { prisma } = require('../config/database');
const { signToken } = require('../middleware/auth');
const { ApiError } = require('../utils/ApiError');
const audit = require('./auditService');

/** Session shape the client stores — no hashes, no secrets. */
const toSession = (user) => ({
  id: user.id,
  staffId: user.staffId,
  staffRef: user.staffRef,
  name: user.name,
  title: user.title,
  department: user.department,
  role: user.roleCode,
  roleName: user.role ? user.role.name : user.roleCode,
  permissions: user.role && Array.isArray(user.role.permissions) ? user.role.permissions : [],
  doctorId: user.doctor ? user.doctor.id : null,
  nurseId: user.nurse ? user.nurse.id : null,
  lastLoginAt: user.lastLoginAt,
});

async function login({ staffId, password, ip = null }) {
  const user = await prisma.user.findUnique({
    where: { staffId },
    include: { role: true, doctor: { select: { id: true } }, nurse: { select: { id: true } } },
  });

  /* Same generic answer for unknown account and wrong password: the API never
     reveals which staff ids exist. */
  if (!user) throw ApiError.unauthorized('Invalid credentials. Check the staff ID and password.');
  if (!user.isActive) throw ApiError.forbidden('This account is inactive. Contact the hospital administrator.');

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) {
    await audit.record({
      action: 'LOGIN_FAILED',
      auth: null,
      entity: 'User',
      entityId: staffId,
      detail: { message: `Failed sign-in attempt for ${staffId}`, tone: 'alert' },
      ip,
    });
    throw ApiError.unauthorized('Invalid credentials. Check the staff ID and password.');
  }

  const updated = await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() }, include: { role: true } });

  /* signToken builds the JWT payload: sub = user id, plus role, staffRef,
     staffId and name. The role travels in the token, never in the request. */
  const token = signToken({
    id: updated.id,
    roleCode: updated.roleCode,
    staffRef: updated.staffRef,
    staffId: updated.staffId,
    name: updated.name,
  });

  audit.record({
    action: 'LOGIN_SUCCEEDED',
    auth: { userId: updated.id, staffRef: updated.staffRef, name: updated.name, role: updated.roleCode },
    entity: 'User',
    entityId: updated.staffId,
    detail: { message: `${updated.name} signed in as ${updated.roleCode}`, tone: 'info' },
    ip,
  });

  return { token, user: toSession({ ...updated, doctor: user.doctor, nurse: user.nurse }) };
}

/** Current session for `GET /api/auth/me`. */
async function me(auth) {
  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    include: { role: true, doctor: { select: { id: true, specialty: true, dutyStatus: true, availability: true } }, nurse: { select: { id: true, department: true, assignedPatients: true } } },
  });
  if (!user || !user.isActive) throw ApiError.unauthorized('This session is no longer valid.');

  const session = toSession(user);
  const [unreadNotifications, pendingApprovals] = await Promise.all([
    prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    prisma.approval.count({ where: { status: 'PENDING_REVIEW' } }),
  ]);

  return {
    ...session,
    doctor: user.doctor,
    nurse: user.nurse,
    unreadNotifications,
    pendingApprovals: user.roleCode === 'resource_coordinator' || user.roleCode === 'command_center' ? pendingApprovals : 0,
  };
}

/**
 * Logout. The signed token stays valid until it expires (stateless JWT), so the
 * event is recorded for the audit trail and the client drops the token.
 */
async function logout({ auth, ip = null }) {
  audit.record({
    action: 'LOGOUT',
    auth,
    entity: 'User',
    entityId: auth.staffRef || auth.staffId,
    detail: { message: `${auth.name || auth.staffRef} signed out`, tone: 'info' },
    ip,
  });
  return { loggedOut: true, staffId: auth.staffId };
}

module.exports = { login, me, logout, toSession };
