import {
  Ambulance,
  BedDouble,
  Bell,
  CalendarClock,
  ClipboardList,
  Cpu,
  Gauge,
  HeartPulse,
  LayoutDashboard,
  ListChecks,
  Package,
  ShieldAlert,
  SlidersHorizontal,
  Stethoscope,
  Users,
  Zap,
} from 'lucide-react';

/**
 * Single navigation configuration for all three dashboards.
 *
 * Refined (sections 9 / 22 / 24): one flat list of pages per role — no nested
 * groups, no duplicated destinations. `badge` maps a live metric onto the
 * sidebar count, `roles` filters items for the doctor/nurse split.
 */

export const NAV_SECTIONS = [
  {
    id: 'command',
    label: 'Command Center',
    roles: ['command_center'],
    items: [
      { to: '/command', label: 'Overview', icon: LayoutDashboard, end: true },
      { to: '/command/queue', label: 'Patient Queue', icon: ListChecks, badge: 'queue' },
      { to: '/command/beds', label: 'Beds', icon: BedDouble },
      { to: '/command/doctors', label: 'Doctors', icon: Stethoscope },
      { to: '/command/nurses', label: 'Nurses', icon: Users },
      { to: '/command/equipment', label: 'Equipment', icon: Package },
      { to: '/command/emergency-resources', label: 'Emergency Resources', icon: Ambulance },
      { to: '/command/surge', label: 'Surge Simulation', icon: Zap },
      { to: '/command/optimization', label: 'Optimization', icon: SlidersHorizontal },
      { to: '/command/alerts', label: 'Alerts', icon: Bell, badge: 'alerts' },
    ],
  },
  {
    id: 'clinical',
    label: 'Clinical Staff',
    roles: ['doctor', 'nurse'],
    items: [
      { to: '/clinical', label: 'Overview', icon: LayoutDashboard, end: true },
      { to: '/clinical/patients', label: 'My Patients', icon: Users, badge: 'patients' },
      { to: '/clinical/emergency', label: 'Emergency Cases', icon: HeartPulse, badge: 'clinicalQueue' },
      { to: '/clinical/ot', label: 'OT Schedule', icon: CalendarClock, roles: ['doctor'] },
      { to: '/clinical/icu', label: 'ICU / Ward', icon: BedDouble },
      { to: '/clinical/duty', label: 'My Duty', icon: ClipboardList },
      { to: '/clinical/notifications', label: 'Notifications', icon: Bell, badge: 'alerts' },
    ],
  },
  {
    id: 'resources',
    label: 'Resource Coordinator',
    roles: ['resource_coordinator'],
    items: [
      { to: '/resources', label: 'Overview', icon: LayoutDashboard, end: true },
      { to: '/resources/beds', label: 'Bed Allocation', icon: BedDouble },
      { to: '/resources/icu', label: 'ICU Allocation', icon: HeartPulse, badge: 'icuBacklog' },
      { to: '/resources/ot', label: 'OT Scheduling', icon: CalendarClock },
      { to: '/resources/doctors', label: 'Doctor Allocation', icon: Stethoscope },
      { to: '/resources/nurses', label: 'Nurse Allocation', icon: Users },
      { to: '/resources/equipment', label: 'Equipment Allocation', icon: Cpu },
      { to: '/resources/conflicts', label: 'Conflicts', icon: ShieldAlert, badge: 'conflicts' },
      { to: '/resources/approvals', label: 'Pending Approvals', icon: Gauge, badge: 'approvals' },
    ],
  },
];

export const getSectionForRole = (role) => NAV_SECTIONS.find((section) => section.roles.includes(role)) || null;

/** Badge counts computed from live hospital metrics. */
export function getBadgeCounts(metrics, state, role) {
  const clinicalQueue = state.queue.filter((entry) => entry.priority === 'Critical' || entry.priority === 'High');
  return {
    queue: metrics.queue.total,
    alerts: metrics.activeAlerts.length,
    conflicts: (state.conflicts || []).filter((conflict) => conflict.status !== 'Mitigated').length,
    approvals: (state.approvals || []).filter((approval) => approval.status === 'Pending Review').length,
    icuBacklog: metrics.queue.icuRequests,
    patients: role === 'doctor' ? 12 : 8,
    tasks: role === 'doctor' ? 1 : 4,
    clinicalQueue: clinicalQueue.length,
  };
}

/** Items visible to the current role, in sidebar order. */
export function getVisibleNav(section, role) {
  if (!section) return [];
  return section.items.filter((item) => !item.roles || item.roles.includes(role));
}

export function findActiveNavItem(section, role, pathname) {
  return (
    getVisibleNav(section, role)
      .filter((item) => (item.end ? pathname === item.to : pathname.startsWith(item.to)))
      .sort((a, b) => b.to.length - a.to.length)[0] || null
  );
}

/** Route prefixes each role is allowed to open. */
const ROLE_ROUTE_PREFIX = {
  command_center: '/command',
  doctor: '/clinical',
  nurse: '/clinical',
  resource_coordinator: '/resources',
};

const ROLE_HOME_PATH = {
  command_center: '/command',
  doctor: '/clinical',
  nurse: '/clinical',
  resource_coordinator: '/resources',
};

/**
 * Alert and notification actions sometimes point at another role's dashboard.
 * Rather than sending a user into an access-restricted screen, resolve the
 * target to a page their role can actually open.
 */
export function resolveActionTarget(role, path) {
  if (!path) return ROLE_HOME_PATH[role] || '/login';
  const prefix = ROLE_ROUTE_PREFIX[role];
  if (!prefix || path.startsWith(prefix)) return path;
  return ROLE_HOME_PATH[role] || '/login';
}

/** Short contextual subtitles — one line, no paragraphs (section 10). */
export const PAGE_DESCRIPTIONS = {
  '/command': 'Hospital status at a glance',
  '/command/queue': 'Patients waiting on a resource',
  '/command/beds': 'Ward capacity and availability',
  '/command/doctors': 'Duty status and current load',
  '/command/nurses': 'Duty status and workload',
  '/command/equipment': 'Availability and utilisation',
  '/command/emergency-resources': 'Emergency bays, ambulances and kits',
  '/command/surge': 'Model an unexpected demand surge',
  '/command/optimization': 'Multi-resource recommendations for review',
  '/command/alerts': 'Critical and operational alerts',
  '/clinical': 'Your duty, patients and tasks',
  '/clinical/patients': 'Patients currently under your care',
  '/clinical/emergency': 'Emergency cases awaiting allocation',
  '/clinical/ot': 'Theatre schedule for today',
  '/clinical/icu': 'Bed status in your assigned area',
  '/clinical/duty': "Today's shift and assignment",
  '/clinical/tasks': 'Outstanding tasks for your shift',
  '/clinical/notifications': 'Notifications for your role',
  '/resources': 'Allocation workload and confirmations',
  '/resources/beds': 'Match patients to available beds',
  '/resources/icu': 'ICU capacity and escalation options',
  '/resources/ot': 'Theatre slots and holds',
  '/resources/doctors': 'Match a specialist requirement to the roster',
  '/resources/nurses': 'Assign nursing cover within workload limits',
  '/resources/equipment': 'Reserve and release equipment',
  '/resources/conflicts': 'Multi-resource conflicts to resolve',
  '/resources/approvals': 'Recommendations awaiting confirmation',
};
