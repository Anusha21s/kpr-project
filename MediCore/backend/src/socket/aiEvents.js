/**
 * HE-02 AI socket events.
 *
 * These sit beside the nine operational events in `bus.js` — they do not
 * replace or rename any of them. Operational events keep their exact names and
 * payloads; the AI layer publishes its own, additively, under an `ai:` prefix so
 * a client can subscribe to forecasts without parsing a changed payload shape.
 *
 * Rooms follow the same rule as the operational events: predictions go to the
 * command centre and the resource coordinator; clinical rooms receive only what
 * concerns their own work. Per-doctor patient detail never travels on a
 * broadcast.
 */

const { room } = require('./bus');

const AI_EVENTS = {
  PREDICTION_UPDATED: 'ai:prediction_updated',
  SURGE_DETECTED: 'ai:surge_detected',
  RESOURCE_PRESSURE_CHANGED: 'ai:resource_pressure_changed',
  RECOMMENDATION_CREATED: 'ai:recommendation_created',
  OPTIMIZATION_COMPLETED: 'ai:optimization_completed',
  SIMULATION_COMPLETED: 'ai:simulation_completed',
  ALLOCATION_APPROVED: 'ai:allocation_approved',
  RESOURCE_CONFLICT_DETECTED: 'ai:resource_conflict_detected',
  ADVISORY_SUMMARY: 'ai:advisory_summary',
  SERVICE_DEGRADED: 'ai:service_degraded',
};

/* The command centre and the resource coordinator hold the operational picture. */
const AI_ROOMS = [room.role('command_center'), room.role('resource_coordinator')];

/* Clinicians are told when an approved plan touches their own assignment. */
const AI_CLINICAL_ROOMS = [...AI_ROOMS, room.role('doctor'), room.role('nurse')];

module.exports = { AI_EVENTS, AI_ROOMS, AI_CLINICAL_ROOMS };
