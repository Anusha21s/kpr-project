import { Link } from 'react-router-dom';
import { useAnimatedInteger } from '../hooks/useAnimatedNumber';

/**
 * Compact KPI tile — one operational concept per tile (section 30).
 * `value` is the headline figure, `caption` carries the context line,
 * `tone` only ever uses the approved palette.
 */
export default function KpiTile({ label, icon: Icon, value, suffix, caption, tone = 'blue', progress, to, detail }) {
  const animated = useAnimatedInteger(typeof value === 'number' ? value : 0);
  const shown = typeof value === 'number' ? animated : value;

  const body = (
    <>
      <div className="kpi-head">
        <span className="kpi-label">{label}</span>
        {Icon ? (
          <span className={`kpi-icon is-${tone}`} aria-hidden="true">
            <Icon size={14} />
          </span>
        ) : null}
      </div>
      <div className="kpi-value">
        {shown}
        {suffix ? <span className="kpi-suffix">{suffix}</span> : null}
      </div>
      {caption ? <p className="kpi-caption">{caption}</p> : null}
      {typeof progress === 'number' ? (
        <div className="kpi-track" aria-hidden="true">
          <span
            className={`bar-fill is-${progress >= 90 ? 'alert' : progress >= 75 ? 'teal' : 'success'}`}
            style={{ width: `${Math.max(0, Math.min(progress, 100))}%` }}
          />
        </div>
      ) : null}
      {detail ? <p className="kpi-detail">{detail}</p> : null}
    </>
  );

  if (to) {
    return (
      <Link className="kpi" to={to} aria-label={`${label}: ${shown}${suffix || ''}. ${caption || ''}`}>
        {body}
      </Link>
    );
  }

  return (
    <article className="kpi" tabIndex={detail ? 0 : undefined} aria-label={`${label}: ${shown}${suffix || ''}`}>
      {body}
    </article>
  );
}
