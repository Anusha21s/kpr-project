import { Link, useNavigate } from 'react-router-dom';
import {
  Ambulance,
  BedDouble,
  Bell,
  HeartPulse,
  ListChecks,
  Package,
  Scissors,
  SlidersHorizontal,
  Stethoscope,
  Users,
  Wind,
  Zap,
} from 'lucide-react';
import KpiTile from '../../components/KpiTile';
import Panel from '../../components/Panel';
import QuickActionGrid from '../../components/QuickActionGrid';
import StatusBadge from '../../components/StatusBadge';
import DataTable from '../../components/DataTable';
import ActivityFeed from '../../components/ActivityFeed';
import WorkflowStrip from '../../components/WorkflowStrip';
import { useHospital } from '../../hooks/useHospital';
import { rankQueue } from '../../utils/optimizationEngine';
import { formatClock } from '../../utils/time';

/**
 * Command Center — "What is happening in the hospital right now?" (section 8).
 *
 * Layout after refinement: critical alerts → capacity KPIs → queue and resource
 * status → quick actions. Detailed tables live on their own pages.
 */
export default function CommandOverview() {
  const { state, metrics, pressure, actions } = useHospital();
  const navigate = useNavigate();

  const criticalAlerts = metrics.criticalAlerts;
  const queueByPriority = rankQueue(state.queue);
  const general = metrics.beds.general;
  const topAlerts = [...criticalAlerts, ...metrics.activeAlerts.filter((alert) => alert.type !== 'Critical')].slice(0, 3);
  const surgeActive = state.surge.active;

  return (
    <div className="page">
      {/* -------------------------------------------------- 1. critical alerts */}
      {topAlerts.length ? (
        <section className="alert-strip" aria-label="Current alerts">
          {topAlerts.map((alert) => (
            <article key={alert.id} className={`alert-line is-${alert.type === 'Critical' ? 'critical' : 'operational'}`}>
              <div className="alert-line-main">
                <span className="alert-line-title">{alert.title}</span>
                <span className="alert-line-meta">
                  {alert.description}
                  <span className="alert-line-dot" aria-hidden="true">·</span>
                  {alert.affectedResource}
                  <span className="alert-line-dot" aria-hidden="true">·</span>
                  {formatClock(new Date(alert.timestamp))}
                </span>
              </div>
              <div className="row row-tight">
                <StatusBadge status={alert.type === 'Critical' ? 'Critical' : 'Operational'} label={alert.type} size="sm" />
                <Link className="btn btn-outline btn-sm" to="/command/alerts">
                  Open
                </Link>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <div className="alert-line is-success" role="status">
          <div className="alert-line-main">
            <span className="alert-line-title">Hospital within configured thresholds</span>
            <span className="alert-line-meta">No critical or operational alerts are open.</span>
          </div>
          <Link className="btn btn-outline btn-sm" to="/command/alerts">
            Alert centre
          </Link>
        </div>
      )}

      {/* ------------------------------------------------------ 2. capacity KPIs */}
      <section className="kpi-row" aria-label="Hospital capacity">
        <KpiTile
          label="General beds"
          icon={BedDouble}
          value={general.occupied}
          suffix={` / ${general.total}`}
          caption={`${general.available} available`}
          progress={general.occupancyPercentage}
          to="/command/beds"
        />
        <KpiTile
          label="ICU"
          icon={HeartPulse}
          tone={metrics.beds.icu.available <= 1 ? 'alert' : 'teal'}
          value={metrics.beds.icu.occupied}
          suffix={` / ${metrics.beds.icu.units}`}
          caption={`${metrics.beds.icu.available} available`}
          progress={metrics.beds.icu.occupancyPercentage}
          to="/command/beds"
        />
        <KpiTile
          label="Doctors"
          icon={Stethoscope}
          value={metrics.doctors.onDuty}
          caption={`${metrics.doctors.available} available for assignment`}
          to="/command/doctors"
        />
        <KpiTile
          label="Nurses"
          icon={Users}
          tone={metrics.nurses.atConstraint > 0 ? 'alert' : 'teal'}
          value={metrics.nurses.onDuty}
          caption={`${metrics.nurses.available} available · ${metrics.nurses.atConstraint} at limit`}
          to="/command/nurses"
        />
      </section>

      {/* ------------------------------------------- 3. queue + resource status */}
      <section className="grid-2">
        <Panel
          title="Emergency queue"
          icon={ListChecks}
          subtitle={`${metrics.queue.total} waiting · ${metrics.queue.critical} critical · longest wait ${metrics.queue.longestWait} min`}
          linkTo="/command/queue"
          linkLabel="All patients"
        >
          <DataTable
            columns={[
              { key: 'id', header: 'Patient', strong: true, render: (row) => <span className="mono">{row.id}</span> },
              { key: 'priority', header: 'Priority', render: (row) => <StatusBadge status={row.priority} size="sm" /> },
              { key: 'requiredResource', header: 'Requires' },
              { key: 'waitingMinutes', header: 'Waiting', render: (row) => `${row.waitingMinutes} min` },
              { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} size="sm" /> },
            ]}
            rows={queueByPriority.slice(0, 5)}
            getRowKey={(row) => row.id}
            onRowClick={(row) => navigate('/command/queue', { state: { focusPatient: row.id } })}
            emptyTitle="No patients waiting"
            emptyText="The emergency queue is clear."
          />
        </Panel>

        <Panel title="Resource status" icon={Package} subtitle="Availability across the constrained resources">
          <ul className="resource-status-list">
            {[
              {
                label: 'ICU',
                value: `${metrics.beds.icu.available} of ${metrics.beds.icu.units}`,
                tone: metrics.beds.icu.available <= 1 ? 'alert' : 'ok',
                hint: 'beds available',
                to: '/command/beds',
                icon: HeartPulse,
              },
              {
                label: 'Emergency bays',
                value: `${metrics.beds.emergency.available} of ${metrics.beds.emergency.total}`,
                tone: metrics.beds.emergency.available <= 1 ? 'alert' : 'ok',
                hint: 'bays available',
                to: '/command/emergency-resources',
                icon: Ambulance,
              },
              {
                label: 'Theatres',
                value: `${metrics.ot.available} of ${metrics.ot.total}`,
                tone: metrics.ot.available === 0 ? 'alert' : 'ok',
                hint: 'free now',
                to: '/command/optimization',
                icon: Scissors,
              },
              {
                label: 'Ventilators',
                value: `${metrics.equipment.ventilators.available} of ${metrics.equipment.ventilators.total}`,
                tone: metrics.equipment.ventilators.available <= 3 ? 'alert' : 'ok',
                hint: 'free',
                to: '/command/equipment',
                icon: Wind,
              },
              {
                label: 'Monitors',
                value: `${metrics.equipment.monitors.available} of ${metrics.equipment.monitors.total}`,
                tone: metrics.equipment.monitors.available <= 4 ? 'alert' : 'ok',
                hint: 'free',
                to: '/command/equipment',
                icon: Package,
              },
              {
                label: 'Capacity pressure',
                value: `${metrics.pressure.overall}%`,
                tone: metrics.pressure.overall >= 80 ? 'alert' : 'ok',
                hint: 'across all resources',
                to: '/command/optimization',
                icon: Bell,
              },
            ].map((row) => (
              <li key={row.label}>
                <Link className="resource-status-row" to={row.to}>
                  <span className={`resource-status-icon is-${row.tone}`} aria-hidden="true">
                    <row.icon size={15} />
                  </span>
                  <span className="resource-status-text">
                    <span className="resource-status-label">{row.label}</span>
                    <span className="resource-status-hint">{row.hint}</span>
                  </span>
                  <span className={`resource-status-value is-${row.tone}`}>{row.value}</span>
                  <span className={`status-dot ${row.tone === 'alert' ? 'is-alert' : 'is-success'}`} aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      </section>

      {/* -------------------------------------------------- 4. quick actions */}
      <section className="grid-2">
        <Panel title="Quick actions" icon={Zap} subtitle="Operational steps for this shift">
          <QuickActionGrid
            columns={2}
            actions={[
              {
                label: surgeActive ? 'Review surge position' : 'Simulate surge',
                hint: surgeActive ? 'Surge already running' : 'Model +20 emergency patients',
                icon: Zap,
                to: '/command/surge',
                tone: 'teal',
              },
              {
                label: 'Optimize resources',
                hint: 'Multi-resource recommendations',
                icon: SlidersHorizontal,
                to: '/command/optimization',
                tone: 'blue',
              },
              {
                label: 'Patient queue',
                hint: `${metrics.queue.total} waiting`,
                icon: ListChecks,
                to: '/command/queue',
              },
              {
                label: 'Alert centre',
                hint: `${metrics.activeAlerts.length} open`,
                icon: Bell,
                to: '/command/alerts',
              },
            ]}
          />
        </Panel>

        <ActivityFeed title="Live activity" limit={6} />
      </section>

      <WorkflowStrip
        stage={state.surge.processed ? 'confirmed' : state.surge.active ? 'recommendation' : 'visibility'}
      />

      <p className="page-footnote">
        Last updated {formatClock(new Date())} · {state.meta.shift.label} ·{' '}
        <button type="button" className="link-button" onClick={actions.refresh}>
          refresh snapshot
        </button>
      </p>
    </div>
  );
}
