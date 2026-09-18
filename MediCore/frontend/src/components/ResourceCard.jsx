import StatusBadge from './StatusBadge';
import UsageBar from './UsageBar';
import { getStatusVariant } from '../utils/display';

/**
 * ResourceCard — the standard representation of an operational resource
 * (ward, staffing group, equipment pool or emergency resource).
 */
export default function ResourceCard({
  name,
  meta,
  icon: Icon,
  status,
  statusLabel,
  stats = [],
  utilisation,
  utilisationLabel = 'Utilisation',
  utilisationMax = 100,
  utilisationTone,
  footer,
  children,
  accent,
  note,
}) {
  const tone = accent || (status ? getStatusVariant(status).variant : 'neutral');

  return (
    <article className={`resource-card ${tone === 'critical' ? 'card--accent-critical' : ''}`}>
      <div className="resource-card-head">
        <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
          {Icon ? (
            <span className={`metric-icon is-${tone === 'critical' ? 'alert' : tone === 'success' ? 'success' : 'blue'}`} aria-hidden="true">
              <Icon size={17} />
            </span>
          ) : null}
          <div>
            <h3 className="resource-name">{name}</h3>
            {meta ? <p className="resource-meta">{meta}</p> : null}
          </div>
        </div>
        {status ? <StatusBadge status={status} label={statusLabel} /> : null}
      </div>

      {stats.length ? (
        <div className="resource-stats">
          {stats.map((stat) => (
            <div className="stat" key={stat.label}>
              <div className="stat-label">{stat.label}</div>
              <div className={`stat-value ${stat.tone ? `is-${stat.tone}` : ''}`}>{stat.value}</div>
            </div>
          ))}
        </div>
      ) : null}

      {typeof utilisation === 'number' ? (
        <UsageBar
          label={utilisationLabel}
          value={utilisation}
          max={utilisationMax}
          tone={utilisationTone}
          helper={utilisationMax === 100 ? undefined : `${utilisationMax} capacity`}
        />
      ) : null}

      {children}

      {note ? <p className="text-xs text-secondary">{note}</p> : null}
      {footer ? <div className="row row-tight" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>{footer}</div> : null}
    </article>
  );
}
