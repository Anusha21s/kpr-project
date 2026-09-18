/**
 * Socket bus.
 *
 * Services never touch the Socket.IO server directly: they publish through this
 * bus, so an operational change made through the REST API produces exactly the
 * same realtime event as one made by the simulation engine.
 *
 * Event names are fixed by the API contract (§34) — no other event is emitted.
 */

const EVENTS = {
  BED_UPDATED: 'bed:updated',
  DOCTOR_AVAILABILITY: 'doctor:availability',
  NURSE_AVAILABILITY: 'nurse:availability',
  EQUIPMENT_UPDATED: 'equipment:updated',
  QUEUE_UPDATED: 'queue:updated',
  SURGE_DETECTED: 'surge:detected',
  OPTIMIZATION_COMPLETED: 'optimization:completed',
  ALLOCATION_UPDATED: 'allocation:updated',
  ALERT_CREATED: 'alert:created',
};

const OPERATIONAL_EVENTS = Object.values(EVENTS);

let io = null;

const setIO = (server) => {
  io = server;
};

const room = {
  user: (userId) => `user:${userId}`,
  role: (role) => `role:${role}`,
  department: (department) => `department:${department}`,
};

const unique = (values) => Array.from(new Set(values.filter(Boolean)));

/**
 * Emits an operational event to explicit rooms.
 * Only the payload that the receiving rooms are allowed to see is sent —
 * per-patient detail never travels on a broadcast (§47).
 */
function emit(event, payload = {}, { rooms = [] } = {}) {
  if (!io) return false;
  const targets = unique(rooms);
  if (!targets.length) return false;
  io.to(targets).emit(event, { event, emittedAt: new Date().toISOString(), ...payload });
  return true;
}

module.exports = { EVENTS, OPERATIONAL_EVENTS, room, setIO, emit, getIO: () => io };
