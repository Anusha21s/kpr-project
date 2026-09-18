/**
 * MediCore — seed constants.
 *
 * Shift blocks, wards and the operational thresholds the backend uses when it
 * derives pressure indicators. These are operational indicators, never
 * clinical thresholds.
 */

const SHIFTS = {
  MORNING: { id: 'MORNING', label: '08:00 AM – 04:00 PM' },
  EVENING: { id: 'EVENING', label: '04:00 PM – 12:00 AM' },
  NIGHT: { id: 'NIGHT', label: '12:00 AM – 08:00 AM' },
};

const WARDS = [
  { id: 'general', name: 'General Ward', unit: 'GENERAL', bedType: 'General Bed', prefix: 'GEN', configured: 60, occupancyPercentage: 75 },
  { id: 'icu', name: 'Intensive Care Unit', unit: 'ICU', bedType: 'ICU Bed', prefix: 'ICU', configured: 10, occupancyPercentage: 80 },
  { id: 'emergency', name: 'Emergency Ward', unit: 'EMERGENCY', bedType: 'Emergency Bed', prefix: 'EMG', configured: 10, occupancyPercentage: 70 },
  { id: 'maternity', name: 'Maternity & Paediatrics', unit: 'MATERNITY', bedType: 'Maternity Bed', prefix: 'MAT', configured: 20, occupancyPercentage: 60 },
];

/** Operational pressure bands (dashboard indicators, not clinical rules). */
const PRESSURE_BANDS = [
  { max: 70, band: 'NORMAL' },
  { max: 85, band: 'MODERATE' },
  { max: 95, band: 'HIGH' },
  { max: Infinity, band: 'CRITICAL' },
];

const NURSE_WORKLOAD_LIMIT = 5;
const DOCTOR_WORKLOAD_LIMIT = 12;

/** Ward totals that make the seeded hospital believable (100 configured beds). */
const SEED_OCCUPANCY = {
  general: { occupied: 45, reserved: 2 },
  icu: { occupied: 8, reserved: 1 }, // 1 vacant → ICU pressure is the demo constraint
  emergency: { occupied: 7, reserved: 1 },
  maternity: { occupied: 12, reserved: 0 },
};

const SURGE_PATIENT_COUNT = 20;

module.exports = {
  SHIFTS,
  WARDS,
  PRESSURE_BANDS,
  NURSE_WORKLOAD_LIMIT,
  DOCTOR_WORKLOAD_LIMIT,
  SEED_OCCUPANCY,
  SURGE_PATIENT_COUNT,
};
