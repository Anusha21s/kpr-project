import { minutesAgoDate } from '../utils/time';

/**
 * Alert centre seed. Timestamps are anchored to the moment the app loads so
 * the active alerts always read as "minutes ago" during a demonstration.
 * Surge and optimisation alerts are appended by HospitalContext.
 */

export const ALERT_CATEGORIES = {
  CRITICAL: 'Critical',
  OPERATIONAL: 'Operational',
};

const alert = (data) => ({
  status: 'Active',
  ...data,
});

export const SEED_ALERTS = [
  alert({
    id: 'ALR-1041',
    type: ALERT_CATEGORIES.CRITICAL,
    category: 'Capacity',
    title: 'ICU capacity critical',
    description:
      'Intensive Care Unit is at 90% occupancy. Only 1 ICU bed remains and 3 ICU requests are pending in the emergency queue.',
    resource: 'ICU Beds',
    affectedResource: 'ICU — 9 / 10 occupied',
    timestamp: minutesAgoDate(6),
    action: { label: 'View bed capacity', to: '/command/beds' },
    source: 'Capacity monitor',
  }),
  alert({
    id: 'ALR-1042',
    type: ALERT_CATEGORIES.CRITICAL,
    category: 'Queue',
    title: 'Emergency queue rising',
    description:
      'Emergency queue increased from 5 to 8 waiting patients over the last 60 minutes, with 2 critical cases under active assessment.',
    resource: 'Emergency Queue',
    affectedResource: 'Emergency — 8 waiting',
    timestamp: minutesAgoDate(4),
    action: { label: 'Open patient queue', to: '/command/queue' },
    source: 'Queue monitor',
  }),
  alert({
    id: 'ALR-1043',
    type: ALERT_CATEGORIES.OPERATIONAL,
    category: 'Workload',
    title: 'Nurse workload high',
    description:
      'ICU nursing workload has reached the high band across 4 nurses. Assigned patient load is at the configured constraint for the department.',
    resource: 'Nursing Staff',
    affectedResource: 'ICU — 33 / 50 patient load',
    timestamp: minutesAgoDate(12),
    action: { label: 'View nurses', to: '/command/nurses' },
    source: 'Workload monitor',
  }),
  alert({
    id: 'ALR-1044',
    type: ALERT_CATEGORIES.OPERATIONAL,
    category: 'Equipment',
    title: 'Equipment utilisation high',
    description:
      'Ventilator utilisation is at 80% with 2 units reserved. Reserve capacity is limited for additional respiratory support demand.',
    resource: 'Ventilators',
    affectedResource: 'Ventilators — 12 / 15 in use',
    timestamp: minutesAgoDate(15),
    action: { label: 'Open equipment', to: '/command/equipment' },
    source: 'Equipment telemetry',
  }),
  alert({
    id: 'ALR-1045',
    type: ALERT_CATEGORIES.OPERATIONAL,
    category: 'Theatre',
    title: 'OT capacity limited',
    description:
      'OT-01 is running long and OT-04 is under maintenance. Only OT-03 is free, with the next slot at 02:30 PM.',
    resource: 'OT Complex',
    affectedResource: 'OT — 3 / 4 active',
    timestamp: minutesAgoDate(21),
    action: { label: 'Open OT schedule', to: '/resources/ot' },
    source: 'Theatre monitor',
  }),
  alert({
    id: 'ALR-1039',
    type: ALERT_CATEGORIES.OPERATIONAL,
    category: 'Theatre',
    title: 'OT-01 procedure running long',
    description: 'Emergency laparotomy in OT-01 is 20 minutes beyond planned duration. Conversion decision pending.',
    resource: 'OT-01',
    affectedResource: 'OT-01 — overrun 20 min',
    timestamp: minutesAgoDate(28),
    status: 'Acknowledged',
    action: { label: 'Review theatre status', to: '/resources/ot' },
    source: 'Theatre monitor',
  }),
  alert({
    id: 'ALR-1036',
    type: ALERT_CATEGORIES.OPERATIONAL,
    category: 'Bed Management',
    title: 'Housekeeping delay on ICU-08',
    description: 'Terminal cleaning cycle for ICU-08 completed after a 12 minute delay. Bed released as available.',
    resource: 'ICU Bed',
    affectedResource: 'ICU-08 — available',
    timestamp: minutesAgoDate(46),
    status: 'Resolved',
    action: { label: 'View bed capacity', to: '/command/beds' },
    source: 'Housekeeping interface',
  }),
];
