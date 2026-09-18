/**
 * Hospital state factory and selectors.
 *
 * `createInitialState()` is the single source of truth for the authored
 * hospital baseline — the same function powers the initial load and the
 * "Reset demo" control, so the demonstration can always be restarted from an
 * identical position.
 */

import { buildBedUnits, WARDS, TOTAL_BEDS } from '../data/beds';
import { DOCTORS } from '../data/doctors';
import { NURSES } from '../data/nurses';
import { EQUIPMENT_CATEGORIES } from '../data/equipment';
import { EMERGENCY_RESOURCES } from '../data/emergencyResources';
import { OT_ROOMS, OT_BACKLOG } from '../data/otSchedules';
import { SEED_ALERTS } from '../data/alerts';
import { INITIAL_QUEUE } from '../data/patients';
import { HOSPITAL } from '../data/hospitalData';
import { getCurrentShiftBlock } from '../data/hospitalData';
import { CLINICAL_TASKS } from '../data/clinical';
import { calculateHospitalMetrics, buildSnapshot } from './simulationEngine';
import { detectConflicts } from './optimizationEngine';

export function createInitialState() {
  const bedUnits = buildBedUnits();
  const baseState = {
    meta: {
      facility: HOSPITAL.facility,
      configuredBeds: TOTAL_BEDS,
      wards: WARDS,
      shift: getCurrentShiftBlock(),
      bootedAt: new Date().toISOString(),
      source: 'MediCore operational data layer (demo)',
    },
    queue: INITIAL_QUEUE.map((entry) => ({ ...entry })),
    doctors: DOCTORS.map((doctor) => ({ ...doctor })),
    nurses: NURSES.map((nurse) => ({ ...nurse })),
    bedUnits,
    equipment: EQUIPMENT_CATEGORIES.map((category) => ({
      ...category,
      units: category.units.map((unit) => ({ ...unit })),
    })),
    emergencyResources: EMERGENCY_RESOURCES.map((resource) => ({ ...resource })),
    otRooms: OT_ROOMS.map((room) => ({ ...room })),
    otBacklog: OT_BACKLOG.map((entry) => ({ ...entry })),
    allocations: [],
    approvals: [],
    clinicalTasks: CLINICAL_TASKS.map((task) => ({ ...task, status: 'Pending' })),
    alerts: SEED_ALERTS.map((alert) => ({ ...alert })),
    conflicts: [],
    escalation: {
      icuStepDownBays: 0,
      emergencyOverflowBays: 0,
      transferReviews: [],
      secondaryResusPoint: false,
      electiveDeferralOffered: null,
    },
    surge: {
      active: false,
      processed: false,
      patientsAdded: 0,
      startedAt: null,
      before: null,
      after: null,
    },
    optimization: null,
    rejectedRecommendations: [],
    simulationHistory: {},
    lastUpdated: new Date().toISOString(),
  };

  const metrics = calculateHospitalMetrics(baseState);
  baseState.conflicts = detectConflicts(baseState, metrics);
  baseState.surge.before = buildSnapshot(baseState, 'Baseline');
  return baseState;
}

/* ------------------------------------------------------------------ *
 * Selectors
 * ------------------------------------------------------------------ */

export const selectQueueByPriority = (state, priority) =>
  state.queue.filter((entry) => entry.priority === priority);

export const selectEligibleDoctors = (doctors, specialty) =>
  doctors
    .filter((doctor) => !specialty || doctor.specialty === specialty)
    .map((doctor) => ({
      ...doctor,
      eligible:
        doctor.dutyStatus === 'ON_DUTY' &&
        doctor.availability === 'Available' &&
        doctor.withinShift !== false,
      eligibilityReason:
        doctor.dutyStatus !== 'ON_DUTY'
          ? 'OFF DUTY — outside duty shift'
          : doctor.availability === 'Busy'
            ? `Unavailable — ${doctor.currentAssignment}`
            : doctor.availability === 'Unavailable'
              ? `Unavailable — ${doctor.currentAssignment}`
              : 'Eligible for recommendation',
    }))
    .sort((a, b) => Number(b.eligible) - Number(a.eligible));

export const selectNursesByDepartment = (nurses, department) =>
  nurses.filter((nurse) => !department || nurse.department === department);

export const selectRoomsByStatus = (otRooms, status) =>
  otRooms.filter((room) => !status || room.status === status);

export const selectAvailableBeds = (bedUnits, wardId) =>
  bedUnits.filter((unit) => unit.status === 'Available' && (!wardId || unit.wardId === wardId));

export const selectBedsByWard = (bedUnits, wardId) =>
  bedUnits.filter((unit) => unit.wardId === wardId);

export const selectQueueCandidatesForResource = (queue, bedType) =>
  queue
    .filter((entry) => entry.requiredResource === bedType || entry.secondaryResource === bedType)
    .sort((a, b) => {
      const rank = { Critical: 0, High: 1, Medium: 2, Low: 3 };
      const byPriority = rank[a.priority] - rank[b.priority];
      return byPriority !== 0 ? byPriority : b.waitingMinutes - a.waitingMinutes;
    });
