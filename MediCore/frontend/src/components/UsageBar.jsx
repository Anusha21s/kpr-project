import { pressureBarVariant } from '../utils/display';

/** Labelled utilisation bar — used for equipment, wards and pressure indices. */
export default function UsageBar({ label, value, max = 100, helper, tone, variant, showPercent = true }) {
  const percent = Math.min(Math.round((value / max) * 100), 100);
  const barVariant = variant !== undefined ? variant : tone ? `is-${tone}` : pressureBarVariant(percent);

  return (
    <div>
      <div className="bar-row">
        <span className="text-medium">{label}</span>
        <span className="text-secondary mono">
          {showPercent ? `${percent}%` : `${value} / ${max}`}
          {helper ? ` · ${helper}` : ''}
        </span>
      </div>
      <div className="bar" role="img" aria-label={`${label}: ${percent} percent`}>
        <span className={`bar-fill ${barVariant}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
