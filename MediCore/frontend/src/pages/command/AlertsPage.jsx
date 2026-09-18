import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, Siren } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import FilterBar from '../../components/FilterBar';
import SearchBar from '../../components/SearchBar';
import StatusBadge from '../../components/StatusBadge';
import EmptyState from '../../components/EmptyState';
import { useHospital } from '../../hooks/useHospital';
import { useAuth } from '../../hooks/useAuth';
import { resolveActionTarget } from '../../utils/navigation';
import { formatClock } from '../../utils/time';

/**
 * Alerts (section 27) — short, immediately understandable lines.
 * Red is used only for critical alerts; everything else stays neutral.
 */
export default function AlertsPage() {
  const { state, actions } = useHospital();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [type, setType] = useState('all');
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState('active');
  const [query, setQuery] = useState('');

  const alerts = useMemo(() => {
    const term = query.trim().toLowerCase();
    return state.alerts
      .filter((alert) => {
        const matchesType = type === 'all' || alert.type === type;
        const matchesCategory = category === 'all' || alert.category === category;
        const matchesStatus =
          status === 'all' ? true : status === 'active' ? alert.status !== 'Resolved' : alert.status === 'Resolved';
        const matchesTerm =
          !term || [alert.title, alert.description, alert.affectedResource].filter(Boolean).some((field) => String(field).toLowerCase().includes(term));
        return matchesType && matchesCategory && matchesStatus && matchesTerm;
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'Critical' ? -1 : 1;
        return new Date(b.timestamp) - new Date(a.timestamp);
      });
  }, [state.alerts, type, category, status, query]);

  const critical = state.alerts.filter((alert) => alert.type === 'Critical' && alert.status !== 'Resolved');
  const operational = state.alerts.filter((alert) => alert.type !== 'Critical' && alert.status !== 'Resolved');
  const resolved = state.alerts.filter((alert) => alert.status === 'Resolved');
  const activeFilters = (type !== 'all' ? 1 : 0) + (category !== 'all' ? 1 : 0) + (status !== 'active' ? 1 : 0) + (query ? 1 : 0);

  return (
    <div className="page">
      <section className="kpi-row" aria-label="Alert summary">
        <KpiTile label="Critical" icon={Siren} tone={critical.length ? 'alert' : 'teal'} value={critical.length} caption="Require immediate action" />
        <KpiTile label="Operational" icon={Bell} value={operational.length} caption="Monitor and plan" />
        <KpiTile label="Resolved" icon={CheckCheck} tone="teal" value={resolved.length} caption="This session" />
        <KpiTile label="Categories" icon={Bell} value={new Set(state.alerts.map((alert) => alert.category)).size} caption="Capacity, queue, staffing, equipment…" />
        <KpiTile label="Affected resources" icon={Bell} value={new Set(state.alerts.map((alert) => alert.affectedResource)).size} caption="Across all open alerts" />
        <KpiTile label="Last raised" icon={Bell} value={state.alerts.length ? formatClock(new Date(Math.max(...state.alerts.map((alert) => new Date(alert.timestamp))))) : '—'} caption="Most recent alert" />
      </section>

      <Panel
        title="Alert centre"
        icon={Bell}
        subtitle={`${alerts.length} alert(s) shown`}
        actions={
          <button type="button" className="btn btn-outline btn-sm" onClick={actions.acknowledgeAll}>
            Acknowledge all
          </button>
        }
      >
        <FilterBar
          search={<SearchBar value={query} onChange={setQuery} onClear={() => setQuery('')} placeholder="Search alerts…" label="Search alerts" id="alert-search" />}
          filters={[
            {
              id: 'type',
              label: 'Type',
              value: type,
              onChange: setType,
              options: [
                { value: 'all', label: 'All types' },
                { value: 'Critical', label: 'Critical' },
                { value: 'Operational', label: 'Operational' },
              ],
            },
            {
              id: 'category',
              label: 'Category',
              value: category,
              onChange: setCategory,
              options: [
                { value: 'all', label: 'All categories' },
                ...Array.from(new Set(state.alerts.map((alert) => alert.category))).map((entry) => ({ value: entry, label: entry })),
              ],
            },
            {
              id: 'status',
              label: 'Status',
              value: status,
              onChange: setStatus,
              options: [
                { value: 'active', label: 'Open' },
                { value: 'resolved', label: 'Resolved' },
                { value: 'all', label: 'All' },
              ],
            },
          ]}
          activeCount={activeFilters}
          resultCount={alerts.length}
          resultLabel="alerts"
          onReset={() => {
            setQuery('');
            setType('all');
            setCategory('all');
            setStatus('active');
          }}
        />

        <div className="alert-list" style={{ marginTop: 12 }}>
          {alerts.length ? (
            alerts.map((alert) => (
              <article key={alert.id} className={`alert-line ${alert.type === 'Critical' ? 'is-critical' : ''}`}>
                <div className="alert-line-main">
                  <span className="alert-line-title">
                    {alert.type === 'Critical' ? '🔴 ' : ''}
                    {alert.title}
                  </span>
                  <span className="alert-line-meta">
                    {alert.description}
                    <span className="alert-line-dot" aria-hidden="true">·</span>
                    {alert.affectedResource}
                    <span className="alert-line-dot" aria-hidden="true">·</span>
                    {alert.category}
                    <span className="alert-line-dot" aria-hidden="true">·</span>
                    {formatClock(new Date(alert.timestamp))}
                  </span>
                </div>
                <div className="row row-tight">
                  <StatusBadge status={alert.type} size="sm" />
                  <StatusBadge status={alert.status} size="sm" />
                  {alert.action?.to ? (
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => navigate(resolveActionTarget(user?.role, alert.action.to))}
                    >
                      {alert.action.label}
                    </button>
                  ) : null}
                  {alert.status !== 'Resolved' ? (
                    <>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => actions.acknowledgeAlert(alert.id)}>
                        Acknowledge
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => actions.resolveAlert(alert.id)}>
                        Resolve
                      </button>
                    </>
                  ) : null}
                </div>
              </article>
            ))
          ) : (
            <EmptyState title="No alerts match this view" text="Change the filters to see other alerts." icon={Bell} />
          )}
        </div>
      </Panel>
    </div>
  );
}
