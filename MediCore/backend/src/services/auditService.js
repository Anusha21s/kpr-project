/**
 * Audit service (§53).
 *
 * Every consequential action writes an audit row: who did it, what changed,
 * which record was touched. Credentials, tokens and secrets are never written.
 */

const { prisma } = require('../config/database');
const logger = require('../utils/logger');

const REDACTED_KEYS = ['password', 'passwordhash', 'token', 'authorization', 'secret', 'jwt'];

function sanitise(detail) {
  if (!detail || typeof detail !== 'object') return detail ?? null;
  const clean = Array.isArray(detail) ? [] : {};
  Object.entries(detail).forEach(([key, value]) => {
    if (REDACTED_KEYS.includes(key.toLowerCase())) {
      clean[key] = '[redacted]';
      return;
    }
    clean[key] = value && typeof value === 'object' ? sanitise(value) : value;
  });
  return clean;
}

const actorFrom = (auth) =>
  auth
    ? {
        userId: auth.userId || null,
        staffId: auth.staffId || null,
        staffRef: auth.staffRef || null,
        name: auth.name || null,
        role: auth.role || null,
      }
    : { userId: null, staffId: null, staffRef: null, name: null, role: 'system' };

/**
 * Records an audit entry. Auditing never breaks the operation it describes:
 * a failure is logged and swallowed.
 */
async function record({ action, auth = null, entity = null, entityId = null, detail = null, ip = null }) {
  try {
    const actor = actorFrom(auth);
    return await prisma.auditLog.create({
      data: {
        action,
        userId: actor.userId,
        actorName: actor.staffRef ? `${actor.name || ''} · ${actor.staffRef}`.trim() : actor.name,
        actorRole: actor.role,
        entity,
        entityId,
        /* `after` holds the recorded detail (message, tone, payload).
           Secrets are stripped before anything is written (§53). */
        after: sanitise(detail) || undefined,
        ip,
      },
    });
  } catch (error) {
    logger.warn(`audit write failed for ${action}: ${error.message}`);
    return null;
  }
}

async function list({ limit = 100, entity = null } = {}) {
  const rows = await prisma.auditLog.findMany({
    where: entity ? { entity } : undefined,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(limit) || 100, 500),
  });
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    actor: { name: row.actorName, role: row.actorRole },
    entity: row.entity,
    entityId: row.entityId,
    detail: row.after,
    timestamp: row.createdAt,
  }));
}

module.exports = { record, list, sanitise };
