/**
 * Shared hospital metadata, shift model, and demo accounts.
 * All mock data for MediCore lives in `src/data` and is imported by the
 * context / engines so nothing is duplicated inside components.
 */

import { minutesAgoLabel } from '../utils/time';

export const HOSPITAL = {
  product: 'MediCore',
  tagline: 'Hospital Command Center & Resource Optimization',
  facility: 'MediCore Multispeciality Hospital — Central Campus',
  systemNote: 'Authorized hospital operations system',
  bedsConfigured: 100,
};

/** Duty shift blocks used by the roster and the duty-window eligibility rule. */
export const SHIFT_BLOCKS = [
  { id: 'NIGHT', label: '12:00 AM – 08:00 AM', startHour: 0, endHour: 8 },
  { id: 'MORNING', label: '08:00 AM – 04:00 PM', startHour: 8, endHour: 16 },
  { id: 'EVENING', label: '04:00 PM – 12:00 AM', startHour: 16, endHour: 24 },
];

/**
 * The prototype is always anchored to the shift block that contains the
 * current clock time, so the roster, duty windows and eligibility rules stay
 * coherent whenever the demonstration is run.
 */
export function getCurrentShiftBlock(date = new Date()) {
  const hour = date.getHours();
  return (
    SHIFT_BLOCKS.find((block) => hour >= block.startHour && hour < block.endHour) ||
    SHIFT_BLOCKS[2]
  );
}

export function getNextShiftBlock(date = new Date()) {
  const current = getCurrentShiftBlock(date);
  const index = SHIFT_BLOCKS.findIndex((block) => block.id === current.id);
  return SHIFT_BLOCKS[(index + 1) % SHIFT_BLOCKS.length];
}

export const DEPARTMENTS = [
  'Emergency',
  'Intensive Care',
  'General Medicine',
  'Cardiology',
  'General Surgery',
  'Orthopaedics',
  'Paediatrics',
  'Anaesthesiology',
  'Pulmonology',
  'Neurology',
];

/** Priority model — colour is always paired with a label and an icon. */
export const PRIORITY_LEVELS = ['Critical', 'High', 'Medium', 'Low'];

/** Demo accounts (mock authentication, no backend required). */
export const demoUsers = [
  {
    staffId: 'CMD001',
    password: 'demo123',
    role: 'command_center',
    name: 'Command Staff',
    title: 'Duty Command Center Officer',
    department: 'Command Center',
  },
  {
    staffId: 'DOC001',
    password: 'demo123',
    role: 'doctor',
    name: 'Dr. Kumar',
    title: 'Senior Consultant — Cardiology',
    department: 'Cardiology',
    staffRef: 'DOC-1042',
  },
  {
    staffId: 'NUR001',
    password: 'demo123',
    role: 'nurse',
    name: 'Nurse Priya',
    title: 'Staff Nurse — ICU',
    department: 'ICU',
    staffRef: 'NUR-201',
  },
  {
    staffId: 'RES001',
    password: 'demo123',
    role: 'resource_coordinator',
    name: 'Resource Coordinator',
    title: 'Bed / ICU / OT Coordinator',
    department: 'Resource Management',
  },
];

export const ROLE_HOME = {
  command_center: '/command',
  doctor: '/clinical',
  nurse: '/clinical',
  resource_coordinator: '/resources',
};

export const ROLE_LABELS = {
  command_center: 'Command Center',
  doctor: 'Doctor',
  nurse: 'Nurse',
  resource_coordinator: 'Resource Coordinator',
};

/**
 * Seeded activity feed — timestamps are anchored to app load time so the feed
 * always reads as recent activity. The live ticker continues from here.
 */
export const ACTIVITY_SEED = [
  { id: 'ACT-1', time: minutesAgoLabel(9), text: 'ICU Bed 08 updated — cleaning cycle completed, bed available', type: 'success' },
  { id: 'ACT-2', time: minutesAgoLabel(8), text: 'Dr. Kumar marked ON DUTY (Cardiology)', type: 'success' },
  { id: 'ACT-3', time: minutesAgoLabel(6), text: 'Patient P008 added to Emergency Queue', type: 'alert' },
  { id: 'ACT-4', time: minutesAgoLabel(5), text: 'Ventilator V-07 reserved for Emergency Case P005', type: 'info' },
  { id: 'ACT-5', time: minutesAgoLabel(3), text: 'Nurse Priya assigned to ICU-02 (post-operative care)', type: 'info' },
  { id: 'ACT-6', time: minutesAgoLabel(2), text: 'Monitor bank reconciled — 7 units in standby', type: 'info' },
];

/** Deterministic activity lines used by the live tick so the feed keeps moving. */
export const ACTIVITY_TEMPLATES = [
  { text: 'ICU Bed 08 confirmed available after housekeeping sign-off', type: 'success' },
  { text: 'Emergency Queue re-prioritised by triage nurse', type: 'info' },
  { text: 'Ventilator V-11 returned to standby pool', type: 'success' },
  { text: 'OT-02 pre-operative checklist started', type: 'info' },
  { text: 'Nurse workload recalculated across ICU and Emergency', type: 'info' },
  { text: 'Dr. Divya Krishnan moved to Emergency Bay 1', type: 'info' },
  { text: 'Patient P019 moved from Emergency Queue to General Ward', type: 'success' },
  { text: 'Equipment telemetry sync completed for OT complex', type: 'info' },
];

/** Charts — seeded historical series (deterministic, no random values). */
export const EMERGENCY_QUEUE_TREND = [
  { time: '08:00', waiting: 3, critical: 0 },
  { time: '09:00', waiting: 4, critical: 0 },
  { time: '10:00', waiting: 5, critical: 1 },
  { time: '11:00', waiting: 6, critical: 1 },
  { time: '12:00', waiting: 7, critical: 2 },
  { time: '12:45', waiting: 8, critical: 2 },
];

export const BED_OCCUPANCY_TREND = [
  { day: 'Mon', general: 68, icu: 70, emergency: 60 },
  { day: 'Tue', general: 72, icu: 80, emergency: 62 },
  { day: 'Wed', general: 70, icu: 80, emergency: 68 },
  { day: 'Thu', general: 74, icu: 90, emergency: 70 },
  { day: 'Fri', general: 76, icu: 90, emergency: 74 },
  { day: 'Sat', general: 73, icu: 90, emergency: 78 },
  { day: 'Sun', general: 75, icu: 90, emergency: 80 },
];

export const WORKLOAD_TREND = [
  { time: '08:00', doctors: 42, nurses: 55 },
  { time: '09:00', doctors: 48, nurses: 58 },
  { time: '10:00', doctors: 55, nurses: 62 },
  { time: '11:00', doctors: 58, nurses: 66 },
  { time: '12:00', doctors: 62, nurses: 71 },
  { time: '12:45', doctors: 66, nurses: 74 },
];

export const UTILISATION_TREND = [
  { time: '08:00', ventilators: 60, monitors: 68, ot: 55 },
  { time: '09:00', ventilators: 66, monitors: 74, ot: 60 },
  { time: '10:00', ventilators: 72, monitors: 78, ot: 70 },
  { time: '11:00', ventilators: 76, monitors: 82, ot: 75 },
  { time: '12:00', ventilators: 78, monitors: 84, ot: 80 },
  { time: '12:45', ventilators: 80, monitors: 84, ot: 85 },
];

/** Trend series are labelled so charts always show the correct headline. */
export const TREND_SERIES = [
  { key: 'waiting', label: 'Patients waiting', color: 'var(--primary-blue)' },
  { key: 'critical', label: 'Critical patients', color: 'var(--alert)' },
];
