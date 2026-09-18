/**
 * Display helpers that map operational states onto the approved palette.
 * Status is always communicated with an icon + text + colour so the interface
 * never relies on colour alone.
 */

import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock,
  MinusCircle,
  ShieldAlert,
  UserCheck,
  UserX,
} from 'lucide-react';

export const PRIORITY_VARIANT = {
  Critical: 'critical',
  High: 'high',
  Medium: 'medium',
  Low: 'low',
};

/** Variants map onto .badge-* classes in index.css */
export const STATUS_VARIANTS = {
  // duty
  ON_DUTY: { variant: 'success', label: 'ON DUTY', icon: UserCheck },
  OFF_DUTY: { variant: 'neutral', label: 'OFF DUTY', icon: UserX },
  // availability
  Available: { variant: 'success', label: 'Available', icon: CheckCircle2 },
  Assigned: { variant: 'medium', label: 'Assigned', icon: UserCheck },
  Busy: { variant: 'high', label: 'Busy', icon: Clock },
  Unavailable: { variant: 'critical', label: 'Unavailable', icon: MinusCircle },
  // beds
  Occupied: { variant: 'high', label: 'Occupied', icon: MinusCircle },
  Reserved: { variant: 'medium', label: 'Reserved', icon: Clock },
  Cleaning: { variant: 'neutral', label: 'Cleaning', icon: CircleDashed },
  Maintenance: { variant: 'neutral', label: 'Maintenance', icon: CircleDashed },
  // queue
  Waiting: { variant: 'critical', label: 'Waiting', icon: Clock },
  'In Assessment': { variant: 'medium', label: 'In Assessment', icon: Clock },
  'Awaiting Allocation': { variant: 'high', label: 'Awaiting Allocation', icon: Clock },
  'Allocation Proposed': { variant: 'info', label: 'Allocation Proposed', icon: Clock },
  Allocated: { variant: 'success', label: 'Allocated', icon: CheckCircle2 },
  'Partially secured': { variant: 'medium', label: 'Partially secured', icon: Clock },
  // alerts
  Active: { variant: 'critical', label: 'Active', icon: ShieldAlert },
  Acknowledged: { variant: 'medium', label: 'Acknowledged', icon: UserCheck },
  Resolved: { variant: 'success', label: 'Resolved', icon: CheckCircle2 },
  // approvals
  'Pending Review': { variant: 'high', label: 'Pending Review', icon: Clock },
  Confirmed: { variant: 'success', label: 'Confirmed', icon: CheckCircle2 },
  Rejected: { variant: 'critical', label: 'Rejected', icon: AlertTriangle },
  // ot
  Ongoing: { variant: 'high', label: 'Procedure ongoing', icon: Clock },
  Scheduled: { variant: 'medium', label: 'Scheduled', icon: Clock },
  Held: { variant: 'high', label: 'Held — reserved', icon: Clock },
  // workload
  Low: { variant: 'success', label: 'Low', icon: CheckCircle2 },
  Moderate: { variant: 'medium', label: 'Moderate', icon: Clock },
  High: { variant: 'critical', label: 'High', icon: AlertTriangle },
  // conflicts / severity
  Critical: { variant: 'critical', label: 'Critical', icon: ShieldAlert },
  Operational: { variant: 'info', label: 'Operational', icon: AlertTriangle },
  Open: { variant: 'critical', label: 'Open', icon: AlertTriangle },
  'Mitigation in progress': { variant: 'medium', label: 'Mitigation in progress', icon: Clock },
  Mitigated: { variant: 'success', label: 'Mitigated', icon: CheckCircle2 },
};

export const getStatusVariant = (status) => STATUS_VARIANTS[status] || { variant: 'neutral', label: status, icon: CircleDashed };

export const formatPercent = (value) => `${Math.round(Number(value) || 0)}%`;

export const formatDelta = (delta, unit = '') => {
  if (delta === 0) return { text: 'no change', direction: 'flat' };
  const sign = delta > 0 ? '+' : '';
  return {
    text: `${sign}${delta}${unit === '%' ? '%' : ''}`,
    direction: delta > 0 ? 'up' : 'down',
  };
};

/** Pressure index → operational label (never colour-only). */
export const pressureLabel = (index) => {
  if (index >= 85) return { label: 'Critical pressure', variant: 'critical' };
  if (index >= 70) return { label: 'High pressure', variant: 'high' };
  if (index >= 50) return { label: 'Moderate pressure', variant: 'medium' };
  return { label: 'Stable', variant: 'success' };
};

export const pressureBarVariant = (index) => {
  if (index >= 85) return 'is-alert';
  if (index >= 70) return '';
  if (index >= 50) return 'is-teal';
  return 'is-success';
};

export const initials = (name = '') =>
  name
    .replace(/^(Dr\.|Nurse)\s+/i, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

export const pluralise = (count, singular, plural = `${singular}s`) =>
  `${count} ${count === 1 ? singular : plural}`;

/** Truncates long operational notes for compact table cells. */
export const summarise = (text = '', limit = 120) =>
  text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
