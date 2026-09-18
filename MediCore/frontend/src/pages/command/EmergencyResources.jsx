import { Link } from 'react-router-dom';
import { Ambulance, Siren, Truck } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import DataTable from '../../components/DataTable';
import StatusBadge from '../../components/StatusBadge';
import UsageBar from '../../components/UsageBar';
import { useHospital } from '../../hooks/useHospital';
import { AMBULANCE_FLEET } from '../../data/emergencyResources';

/**
 * Emergency Resources (section 17) — resource, available, in use, status,
 * ordered so anything under pressure appears first.
 */
export default function EmergencyResources() {
  const { metrics } = useHospital();

  const resources = metrics.emergencyResources;
  const underPressure = resources.filter((resource) => resource.available <= 1);
  const ordered = [...resources].sort((a, b) => a.available - b.available);
  const ambulances = metrics.emergencyResources.find((resource) => resource.id === 'ambulances');

  return (
    <div className="page">
      {underPressure.length ? (
        <div className="alert-line is-critical" role="status">
          <div className="alert-line-main">
            <span className="alert-line-title">
              {underPressure.length} emergency resource{underPressure.length === 1 ? '' : 's'} at or below one unit
            </span>
            <span className="alert-line-meta">
              {underPressure.map((resource) => `${resource.name} ${resource.available}/${resource.total}`).join(' · ')}
            </span>
          </div>
          <Link className="btn btn-outline btn-sm" to="/command/alerts">
            Open alerts
          </Link>
        </div>
      ) : null}

      <section className="kpi-row" aria-label="Emergency resources">
        {resources.slice(0, 4).map((resource) => (
          <KpiTile
            key={resource.id}
            label={resource.name}
            icon={resource.id === 'ambulances' ? Truck : resource.id === 'resus' ? Siren : Ambulance}
            tone={resource.available <= 1 ? 'alert' : 'teal'}
            value={resource.available}
            caption={`${resource.inUse} in use · ${resource.total} total`}
          />
        ))}
        <KpiTile label="Resuscitation" icon={Siren} tone={metrics.queue.resusRequests ? 'alert' : 'teal'} value={metrics.queue.resusRequests} caption="Cases requiring resus capacity" />
        <KpiTile label="Emergency bays" icon={Ambulance} value={metrics.beds.emergency.available} caption={`${metrics.queue.emergencyBedRequests} bays requested`} />
      </section>

      <Panel title="Emergency resource status" icon={Siren} subtitle="Ordered by pressure — lowest availability first">
        <DataTable
          columns={[
            { key: 'name', header: 'Resource', strong: true },
            { key: 'available', header: 'Available' },
            { key: 'inUse', header: 'In use' },
            { key: 'total', header: 'Total' },
            {
              key: 'status',
              header: 'Status',
              render: (row) =>
                row.available <= 1 ? (
                  <StatusBadge status="Critical" label="At capacity" size="sm" />
                ) : row.available <= Math.max(2, Math.round(row.total * 0.25)) ? (
                  <StatusBadge status="High" label="Under pressure" size="sm" />
                ) : (
                  <StatusBadge status="Available" label="Available" size="sm" />
                ),
            },
          ]}
          rows={ordered}
          getRowKey={(row) => row.id}
        />
      </Panel>

      <section className="grid-2">
        <Panel title="Utilisation" icon={Ambulance} subtitle="Committed capacity per resource">
          <div className="stack">
            {ordered.map((resource) => (
              <UsageBar
                key={resource.id}
                label={resource.name}
                value={resource.utilisation}
                tone={resource.utilisation >= 90 ? 'alert' : resource.utilisation >= 75 ? 'teal' : 'success'}
              />
            ))}
          </div>
        </Panel>

        <Panel title="Ambulance fleet" icon={Truck} subtitle="Availability against status">
          <DataTable
            columns={[
              { key: 'id', header: 'Unit', strong: true, render: (row) => <span className="mono">{row.id}</span> },
              { key: 'type', header: 'Type' },
              { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} size="sm" /> },
            ]}
            rows={AMBULANCE_FLEET}
            getRowKey={(row) => row.id}
            compact
          />
          <p className="panel-note">
            {ambulances ? `${ambulances.available} of ${ambulances.total} ambulances available for dispatch.` : null}
          </p>
        </Panel>
      </section>
    </div>
  );
}
