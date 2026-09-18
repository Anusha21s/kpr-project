import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BedDouble } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import DataTable from '../../components/DataTable';
import StatusBadge from '../../components/StatusBadge';
import DetailModal from '../../components/DetailModal';
import UsageBar from '../../components/UsageBar';
import StatTile from '../../components/StatTile';
import { useHospital } from '../../hooks/useHospital';

/**
 * Beds (section 13) — totals, then compact unit-level rows with progress bars.
 * Bed-by-bed detail lives in a modal; explanations were removed.
 */
export default function BedCapacity() {
  const { metrics, state } = useHospital();
  const [selected, setSelected] = useState(null);
  const [ward, setWard] = useState('all');

  const wards = metrics.beds.wards;
  const units = state.bedUnits.filter(
    (unit) => ward === 'all' || unit.wardId === ward,
  );

  return (
    <div className="page">
      <section className="kpi-row" aria-label="Bed capacity">
        <KpiTile label="Total beds" icon={BedDouble} value={metrics.beds.total} caption={`${metrics.beds.wards.length} wards`} />
        <KpiTile label="Occupied" icon={BedDouble} value={metrics.beds.committed} caption={`${metrics.beds.occupied} in use · ${metrics.beds.reserved} held`} />
        <KpiTile label="Available" icon={BedDouble} tone={metrics.beds.available <= 5 ? 'alert' : 'teal'} value={metrics.beds.available} caption="Ready for allocation" />
        <KpiTile label="Occupancy" icon={BedDouble} value={metrics.beds.occupancyPercentage} suffix="%" caption="Of configured capacity" progress={metrics.beds.occupancyPercentage} />
        <KpiTile label="ICU vacant" icon={BedDouble} tone={metrics.beds.icu.available <= 1 ? 'alert' : 'teal'} value={metrics.beds.icu.available} caption={`${metrics.queue.icuRequests} ICU requests waiting`} />
        <KpiTile label="Escalation beds" icon={BedDouble} value={metrics.beds.escalation} caption={metrics.beds.escalation ? 'Step-down bays active' : 'Available on request'} />
      </section>

      <section className="grid-2">
        <Panel title="Ward capacity" icon={BedDouble} subtitle="Occupied, held and available per ward">
          <div className="stack">
            {wards.map((entry) => (
              <div key={entry.id} className="ward-row">
                <div className="ward-row-head">
                  <span className="ward-row-name">{entry.name}</span>
                  <span className="ward-row-count">
                    {entry.committed} / {entry.total}
                    <span className={`ward-row-free ${entry.available <= 1 ? 'is-alert' : ''}`}>{entry.available} free</span>
                  </span>
                </div>
                <UsageBar
                  label={`${entry.occupancyPercentage}% occupied`}
                  value={entry.occupancyPercentage}
                  tone={entry.occupancyPercentage >= 90 ? 'alert' : entry.occupancyPercentage >= 75 ? 'teal' : 'success'}
                />
              </div>
            ))}
          </div>
          <p className="panel-note">
            Availability is capacity-based: escalation beds and overflow bays are held for critical arrivals and never blocked by
            routine allocation.
          </p>
        </Panel>

        <div className="stack-lg">
          <Panel title="Allocation outlook" icon={BedDouble} subtitle="Demand against availability">
            <div className="stat-grid cols-2">
              <StatTile label="General requests" value={metrics.queue.generalBedRequests} hint={`${metrics.beds.general.available} available`} />
              <StatTile label="Emergency requests" value={metrics.queue.emergencyBedRequests} hint={`${metrics.beds.emergency.available} bays available`} tone="alert" />
              <StatTile label="ICU requests" value={metrics.queue.icuRequests} hint={`${metrics.beds.icu.available} ICU beds vacant`} tone="alert" />
              <StatTile label="Resuscitation" value={metrics.queue.resusRequests} hint={`${metrics.emergencyResources.find((entry) => entry.id === 'resus').available} resus bays`} />
            </div>
            <p className="panel-note">
              Projected bed pressure: <strong>{metrics.pressure.byId.beds.pressure} index</strong>.{' '}
              {metrics.pressure.byId.beds.detail}
            </p>
          </Panel>

          <Panel title="Unit register" icon={BedDouble} subtitle={`${units.length} unit(s)`} actions={
            <label className="text-xs text-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="uppercase-label">Ward</span>
              <select className="select" value={ward} onChange={(event) => setWard(event.target.value)} aria-label="Filter by ward">
                <option value="all">All wards</option>
                {wards.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
          }>
            <DataTable
              columns={[
                { key: 'id', header: 'Bed', strong: true, render: (row) => <span className="mono">{row.id}</span> },
                { key: 'ward', header: 'Ward' },
                { key: 'bedType', header: 'Type' },
                { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} size="sm" /> },
                { key: 'patient', header: 'Patient', render: (row) => (row.patient ? <span className="mono">{row.patient}</span> : '—') },
              ]}
              rows={units}
              getRowKey={(row) => row.id}
              onRowClick={(row) => setSelected(row)}
              compact
            />
          </Panel>
        </div>
      </section>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `Bed ${selected.id}` : ''}
        subtitle={selected ? `${selected.ward} · ${selected.bedType}` : ''}
        badge={selected ? <StatusBadge status={selected.status} size="sm" /> : null}
        footer={
          selected ? (
            <Link className="btn btn-primary" to="/command/optimization">
              Review allocation options
            </Link>
          ) : null
        }
      >
        {selected ? (
          <>
            <div className="stat-grid cols-2">
              <StatTile label="Patient" value={selected.patient || 'Unoccupied'} hint={selected.patient ? 'Currently admitted' : 'Ready for allocation'} />
              <StatTile label="Held for" value={selected.heldFor || '—'} hint="Provisional hold" />
              <StatTile label="Ward" value={selected.ward} />
              <StatTile label="Escalation bed" value={selected.escalation ? 'Yes' : 'No'} />
            </div>
            <div className="row row-tight">
              {selected.features.map((feature) => (
                <span className="badge badge-neutral text-xs" key={feature}>
                  {feature}
                </span>
              ))}
            </div>
          </>
        ) : null}
      </DetailModal>
    </div>
  );
}
