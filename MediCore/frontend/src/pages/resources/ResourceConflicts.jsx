import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldAlert, TriangleAlert } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import FilterBar from '../../components/FilterBar';
import StatusBadge from '../../components/StatusBadge';
import DetailModal from '../../components/DetailModal';
import StatTile from '../../components/StatTile';
import EmptyState from '../../components/EmptyState';
import { useHospital } from '../../hooks/useHospital';
import { detectConflicts } from '../../utils/optimizationEngine';

/**
 * Resource Conflicts (section 29) — open conflicts, the gap behind each, and the
 * linked recommendations. Conflicts are derived from live demand vs capacity.
 */
export default function ResourceConflicts() {
  const { state, metrics, actions } = useHospital();
  const [severity, setSeverity] = useState('all');
  const [selected, setSelected] = useState(null);

  const conflicts = useMemo(() => {
    const live = detectConflicts(state, metrics);
    return (live.length ? live : state.conflicts).filter((entry) => severity === 'all' || entry.severity === severity);
  }, [state, metrics, severity]);

  const allOpen = state.conflicts;
  const gaps = allOpen.filter((entry) => typeof entry.gap === 'number');

  return (
    <div className="page">
      <section className="kpi-row" aria-label="Conflict summary">
        <KpiTile label="Open conflicts" icon={ShieldAlert} tone={allOpen.length ? 'alert' : 'teal'} value={allOpen.length} caption="Demand above current capacity" />
        <KpiTile label="Capacity shortfall" icon={TriangleAlert} tone={gaps.length ? 'alert' : 'teal'} value={gaps.reduce((total, entry) => total + (entry.gap || 0), 0)} caption="Units short across conflicts" />
        <KpiTile label="Resources affected" icon={TriangleAlert} value={new Set(allOpen.map((entry) => entry.title)).size} caption="Beds, theatres, nursing, equipment" />
        <KpiTile label="With recommendations" icon={TriangleAlert} tone="teal" value={allOpen.filter((entry) => entry.linkedRecommendations?.length).length} caption="Linked to an allocation option" />
        <KpiTile label="Highest pressure" icon={ShieldAlert} tone="alert" value={metrics.pressure.overall} suffix="%" caption={metrics.pressure.resources.slice(0, 2).map((entry) => entry.name).join(', ')} progress={metrics.pressure.overall} />
        <KpiTile label="Approvals pending" icon={TriangleAlert} value={state.approvals.filter((approval) => approval.status === 'Pending').length} caption="Awaiting coordinator review" />
      </section>

      <Panel
        title="Open conflicts"
        icon={ShieldAlert}
        subtitle={`${conflicts.length} conflict(s) shown · derived from live demand against capacity`}
      >
        <FilterBar
          filters={[
            {
              id: 'severity',
              label: 'Severity',
              value: severity,
              onChange: setSeverity,
              options: [
                { value: 'all', label: 'All severities' },
                { value: 'Operational', label: 'Operational' },
                { value: 'Critical', label: 'Critical' },
              ],
            },
          ]}
          activeCount={severity !== 'all' ? 1 : 0}
          resultCount={conflicts.length}
          resultLabel="conflicts"
          onReset={() => setSeverity('all')}
        />

        <div className="stack" style={{ marginTop: 12 }}>
          {conflicts.length ? (
            conflicts.map((conflict) => (
              <article key={conflict.id} className="alert-line is-critical">
                <div className="alert-line-main">
                  <span className="alert-line-title">{conflict.title}</span>
                  <span className="alert-line-meta">{conflict.summary}</span>
                </div>
                <div className="row row-tight">
                  <StatusBadge status={conflict.severity} size="sm" />
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setSelected(conflict)}>
                    Review
                  </button>
                  <Link className="btn btn-ghost btn-sm" to="/resources/approvals">
                    Approvals
                  </Link>
                </div>
              </article>
            ))
          ) : (
            <EmptyState title="No conflicts at this severity" text="Change the filter to see other conflicts." icon={ShieldAlert} />
          )}
        </div>
      </Panel>

      <Panel title="Recommended review path" icon={TriangleAlert} subtitle="The order coordination should work through these">
        <ol className="rationale-list">
          <li>Confirm the clinical requirement recorded by the treating team.</li>
          <li>Apply the allocation options raised on the approvals board — escalations, holds and deployments are reviewed, never automatic.</li>
          <li>Escalate to the command center if demand still exceeds capacity after review.</li>
          <li>Re-run the optimisation analysis to refresh the recommendation set.</li>
        </ol>
      </Panel>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.title}
        subtitle={selected ? `Conflict ${selected.id} · detected ${selected.detectedAt ? new Date(selected.detectedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'this session'}` : ''}
        size="md"
        badge={selected ? <StatusBadge status={selected.severity} size="sm" /> : null}
        footer={
          selected ? (
            <>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => {
                  actions.pushActivity(`Conflict ${selected.id} escalated to the command center for review`, 'alert');
                  setSelected(null);
                }}
              >
                Escalate to command center
              </button>
              <Link className="btn btn-primary" to="/resources/approvals">
                Open approvals
              </Link>
            </>
          ) : null
        }
      >
        {selected ? (
          <>
            <div className="stat-grid cols-3">
              <StatTile label="Demand" value={selected.demand ?? '—'} hint="Required units" />
              <StatTile label="Capacity" value={selected.capacity ?? '—'} hint="Currently free" />
              <StatTile label="Gap" value={selected.gap ?? '—'} tone={(selected.gap || 0) > 0 ? 'alert' : 'neutral'} hint="Units short" />
            </div>
            <p className="text-small text-secondary">{selected.detail}</p>
            <Panel title="Operational actions" icon={TriangleAlert} compact>
              <ul className="rationale-list">
                {(selected.actions || []).map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </Panel>
            {selected.linkedRecommendations?.length ? (
              <div className="row row-tight">
                {selected.linkedRecommendations.map((entry) => (
                  <span className="badge badge-info text-xs" key={entry}>
                    {entry}
                  </span>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </DetailModal>
    </div>
  );
}
