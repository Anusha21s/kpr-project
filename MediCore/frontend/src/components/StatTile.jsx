/**
 * StatTile / StatGrid — compact secondary metric display.
 *
 * Used inside panels and modals where a full KPI card would be too heavy.
 * One label, one value, one optional hint. No charts, no icons by default.
 */
export function StatTile({ label, value, suffix, hint, tone = 'neutral' }) {
  return (
    <div className={`stat-tile is-${tone}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value}
        {suffix ? <span className="stat-suffix">{suffix}</span> : null}
      </span>
      {hint ? <span className="stat-hint">{hint}</span> : null}
    </div>
  );
}

export function StatGrid({ columns = 4, children }) {
  return <div className={`stat-grid cols-${columns}`}>{children}</div>;
}

export default StatTile;
