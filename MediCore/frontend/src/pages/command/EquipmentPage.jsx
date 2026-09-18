import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Package } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import DataTable from '../../components/DataTable';
import StatusBadge from '../../components/StatusBadge';
import UsageBar from '../../components/UsageBar';
import DetailModal from '../../components/DetailModal';
import StatTile from '../../components/StatTile';
import { useHospital } from '../../hooks/useHospital';

/**
 * Equipment (section 16) — equipment, total, available, in use, status.
 * Unit-level registers live in the equipment allocation page.
 */
export default function EquipmentPage() {
  const { metrics, state, actions } = useHospital();
  const [selected, setSelected] = useState(null);

  const categories = state.equipment.map((category) => ({
    ...category,
    utilisation: Math.round((category.inUse / Math.max(category.total, 1)) * 100),
    free: category.total - category.inUse,
  }));
  const ventilatorPressure = metrics.queue.ventilatorRequests > metrics.equipment.ventilators.available;

  return (
    <div className="page">
      {ventilatorPressure ? (
        <div className="alert-line is-critical" role="status">
          <div className="alert-line-main">
            <span className="alert-line-title">Ventilator demand exceeds availability</span>
            <span className="alert-line-meta">
              {metrics.queue.ventilatorRequests} queued patients require ventilation · {metrics.equipment.ventilators.available}{' '}
              units free
            </span>
          </div>
          <Link className="btn btn-primary btn-sm" to="/command/optimization">
            Reserve units
          </Link>
        </div>
      ) : null}

      <section className="kpi-row" aria-label="Equipment position">
        <KpiTile label="Overall utilisation" icon={Package} tone={metrics.equipment.utilisation >= 90 ? 'alert' : 'blue'} value={metrics.equipment.utilisation} suffix="%" caption={`${metrics.equipment.totalUnits} units tracked`} progress={metrics.equipment.utilisation} />
        <KpiTile label="Ventilators" icon={Package} tone={metrics.equipment.ventilators.available <= 3 ? 'alert' : 'teal'} value={metrics.equipment.ventilators.available} caption={`${metrics.equipment.ventilators.inUse} in use · ${metrics.equipment.ventilators.reserved} reserved`} />
        <KpiTile label="Monitors" icon={Package} value={metrics.equipment.monitors.available} caption={`${metrics.equipment.monitors.inUse} in use`} />
        <KpiTile label="OT equipment" icon={Package} value={metrics.equipment.otEquipment.available} caption={`${metrics.equipment.otEquipment.inUse} in use`} />
        <KpiTile label="Ventilator requests" icon={Package} tone={ventilatorPressure ? 'alert' : 'blue'} value={metrics.queue.ventilatorRequests} caption="Queued patients" />
        <KpiTile label="Free units" icon={Package} tone="teal" value={categories.reduce((total, category) => total + category.free, 0)} caption="Across all pools" />
      </section>

      <Panel title="Equipment pools" icon={Package} subtitle="Availability by category — reserve units from the allocation page">
        <DataTable
          columns={[
            { key: 'name', header: 'Equipment', strong: true },
            { key: 'total', header: 'Total' },
            { key: 'available', header: 'Available', render: (row) => row.total - row.inUse },
            { key: 'inUse', header: 'In use' },
            {
              key: 'status',
              header: 'Status',
              render: (row) =>
                row.total - row.inUse <= 2 ? (
                  <StatusBadge status="Critical" label="Under pressure" size="sm" />
                ) : row.total - row.inUse <= 5 ? (
                  <StatusBadge status="High" label="Tight" size="sm" />
                ) : (
                  <StatusBadge status="Available" label="Sufficient" size="sm" />
                ),
            },
          ]}
          rows={categories}
          getRowKey={(row) => row.id}
          onRowClick={(row) => setSelected(row)}
          emptyTitle="No equipment tracked"
        />
      </Panel>

      <section className="grid-2">
        <Panel title="Utilisation by pool" icon={Package} subtitle="Units in use against units available">
          <div className="stack">
            {categories.map((category) => (
              <UsageBar
                key={category.id}
                label={category.name}
                value={category.utilisation}
                tone={category.utilisation >= 90 ? 'alert' : category.utilisation >= 75 ? 'teal' : 'success'}
              />
            ))}
          </div>
        </Panel>

        <Panel title="Critical equipment" icon={Package} subtitle="Flagged for coordinator review">
          <ul className="resource-status-list">
            {categories
              .filter((category) => category.free <= 3)
              .map((category) => (
                <li key={category.id}>
                  <div className="resource-status-row">
                    <span className={`resource-status-icon ${category.free <= 2 ? 'is-alert' : ''}`} aria-hidden="true">
                      <Package size={15} />
                    </span>
                    <span className="resource-status-text">
                      <span className="resource-status-label">{category.name}</span>
                      <span className="resource-status-hint">{category.criticalFor || category.description}</span>
                    </span>
                    <span className={`resource-status-value ${category.total - category.inUse <= 2 ? 'is-alert' : ''}`}>
                      {category.total - category.inUse} free
                    </span>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => actions.pushActivity(`${category.name} flagged for the resource coordinator`, 'alert')}
                    >
                      Flag
                    </button>
                  </div>
                </li>
              ))}
            {categories.filter((category) => category.total - category.inUse <= 3).length === 0 ? (
              <li>
                <p className="empty-line">No equipment pool is under pressure.</p>
              </li>
            ) : null}
          </ul>
        </Panel>
      </section>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.name}
        subtitle={selected?.description}
        badge={selected ? <StatusBadge status={selected.total - selected.inUse <= 2 ? 'Critical' : 'Available'} label={`${selected.total - selected.inUse} free`} size="sm" /> : null}
        footer={selected ? <Link className="btn btn-primary" to="/command/optimization">Review equipment allocation</Link> : null}
      >
        {selected ? (
          <>
            <div className="stat-grid cols-3">
              <StatTile label="Total" value={selected.total} hint="Units in the pool" />
              <StatTile label="Available" value={selected.total - selected.inUse} hint="Ready to reserve" />
              <StatTile label="In use" value={selected.inUse} hint={`${selected.utilisation}% utilised`} />
            </div>
            <div className="kv">
              <span className="kv-key">Location</span>
              <span className="kv-value">{selected.location}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Critical for</span>
              <span className="kv-value">{selected.criticalFor || 'General ward use'}</span>
            </div>
          </>
        ) : null}
      </DetailModal>
    </div>
  );
}
