import { useMemo, useState } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import FilterBar from '../../components/FilterBar';
import StatusBadge from '../../components/StatusBadge';
import EmptyState from '../../components/EmptyState';
import { useHospital } from '../../hooks/useHospital';
import { useAuth } from '../../hooks/useAuth';
import { CLINICAL_NOTIFICATIONS } from '../../data/clinical';
import { formatClock } from '../../utils/time';

/**
 * Notifications (section 26) — one line of context per notification.
 * Role-relevant operational alerts are merged with the clinical feed.
 */
export default function ClinicalNotifications() {
  const { state, actions } = useHospital();
  const { user } = useAuth();
  const [type, setType] = useState('all');
  const [unreadOnly, setUnreadOnly] = useState('all');
  const [hidden, setHidden] = useState([]);

  const items = useMemo(() => {
    const clinical = CLINICAL_NOTIFICATIONS.filter((entry) => entry.audience.includes(user.role)).map((entry) => {
      const [, minutes] = String(entry.time).split(':');
      return {
        id: entry.id,
        title: entry.title,
        body: entry.body,
        type: entry.type,
        at: new Date(Date.now() - Number(minutes || 0) * 60000),
      };
    });

    const operational = state.alerts
      .filter((alert) => ['Capacity', 'Queue', 'Workload', 'Equipment', 'Theatre', 'Conflict'].includes(alert.category))
      .map((alert) => ({
        id: alert.id,
        title: alert.title,
        body: `${alert.description}`,
        type: alert.type,
        at: new Date(alert.timestamp),
        alertId: alert.id,
        status: alert.status,
      }));

    return [...operational, ...clinical]
      .filter((entry) => !hidden.includes(entry.id))
      .sort((a, b) => b.at - a.at);
  }, [state.alerts, user.role, hidden]);

  const rows = items.filter((entry) => (type === 'all' ? true : entry.type === type));

  return (
    <div className="page">
      <section className="kpi-row" aria-label="Notification summary">
        <KpiTile label="Notifications" icon={Bell} value={items.length} caption="Relevant to my role" />
        <KpiTile label="Critical" icon={Bell} tone={items.some((entry) => entry.type === 'Critical') ? 'alert' : 'teal'} value={items.filter((entry) => entry.type === 'Critical').length} caption="Require attention" />
        <KpiTile label="Operational" icon={Bell} value={items.filter((entry) => entry.type !== 'Critical').length} caption="Monitor and plan" />
        <KpiTile label="Shift handover" icon={Bell} tone="teal" value="Due" caption="45 minutes before shift end" />
        <KpiTile label="Latest" icon={Bell} value={items[0] ? formatClock(items[0].at) : '—'} caption="Most recent notification" />
        <KpiTile label="Dismissed" icon={Bell} value={hidden.length} caption="This session" />
      </section>

      <Panel
        title="Notifications"
        icon={Bell}
        subtitle={`${rows.length} shown · acknowledge to clear operational alerts`}
        actions={
          <button type="button" className="btn btn-outline btn-sm" onClick={actions.acknowledgeAll}>
            <CheckCheck size={13} aria-hidden="true" />
            Acknowledge all
          </button>
        }
      >
        <FilterBar
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
              id: 'read',
              label: 'View',
              value: unreadOnly,
              onChange: setUnreadOnly,
              options: [
                { value: 'all', label: 'All' },
                { value: 'open', label: 'Open only' },
              ],
            },
          ]}
          activeCount={(type !== 'all' ? 1 : 0) + (unreadOnly !== 'all' ? 1 : 0)}
          resultCount={rows.length}
          resultLabel="notifications"
          onReset={() => {
            setType('all');
            setUnreadOnly('all');
          }}
        />

        <div className="alert-strip" style={{ marginTop: 12 }}>
          {rows.length ? (
            rows.map((entry) => (
              <article key={entry.id} className={`alert-line ${entry.type === 'Critical' ? 'is-critical' : ''}`}>
                <div className="alert-line-main">
                  <span className="alert-line-title">
                    {entry.type === 'Critical' ? '🔴 ' : ''}
                    {entry.title}
                  </span>
                  <span className="alert-line-meta">
                    {entry.body}
                    <span className="alert-line-dot" aria-hidden="true">·</span>
                    {formatClock(entry.at)}
                  </span>
                </div>
                <div className="row row-tight">
                  <StatusBadge status={entry.type} size="sm" />
                  {entry.alertId && entry.status !== 'Resolved' ? (
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => actions.acknowledgeAlert(entry.alertId)}>
                      Acknowledge
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHidden((current) => [...current, entry.id])}>
                    Dismiss
                  </button>
                </div>
              </article>
            ))
          ) : (
            <EmptyState title="Nothing to show" text="No notifications match this view." icon={Bell} />
          )}
        </div>
      </Panel>
    </div>
  );
}
