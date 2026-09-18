import { getStatusVariant, PRIORITY_VARIANT } from '../utils/display';

/**
 * Status / priority badge.
 * Always renders icon + label + colour (accessibility rule: never colour-only).
 */
export default function StatusBadge({ status, label, icon: IconOverride, size = 'md', showIcon = true, className = '' }) {
  const meta = getStatusVariant(status);
  const variant = PRIORITY_VARIANT[status] || meta.variant;
  const Icon = IconOverride || meta.icon;
  const text = label || meta.label || status;

  return (
    <span className={`badge badge-${variant} ${size === 'sm' ? 'text-xs' : ''} ${className}`}>
      {showIcon && Icon ? <Icon size={size === 'sm' ? 11 : 12} aria-hidden="true" /> : null}
      {text}
    </span>
  );
}

export function PriorityBadge({ priority, size = 'md' }) {
  return <StatusBadge status={priority} size={size} />;
}

export function SeverityBadge({ severity }) {
  return <StatusBadge status={severity} />;
}

export function StatusLine({ status, label, tone }) {
  const variant = tone || getStatusVariant(status).variant;
  const text = label || getStatusVariant(status).label;
  return (
    <span className="status-line">
      <span className={`status-dot ${variant === 'critical' ? 'is-alert' : `is-${variant}`}`} aria-hidden="true" />
      {text}
    </span>
  );
}
