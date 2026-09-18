import { useMemo, useState } from 'react';
import { Package } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import DataTable from '../../components/DataTable';
import StatusBadge from '../../components/StatusBadge';
import SearchBar from '../../components/SearchBar';
import FilterBar from '../../components/FilterBar';
import ConfirmationModal from '../../components/ConfirmationModal';
import DetailModal from '../../components/DetailModal';
import StatTile from '../../components/StatTile';
import UsageBar from '../../components/UsageBar';
import { useHospital } from '../../hooks/useHospital';

const availableUnits = (category) => category.units.filter((unit) => !unit.inUse && !unit.reserved);
const categoryStatus = (category) => {
  const free = availableUnits(category).length;
  if (free === 0) return 'Critical';
  if (free <= Math.max(1, Math.round(category.total * 0.15))) return 'High';
  return 'Available';
};

/**
 * Equipment Allocation (section 22) — category pressure, unit-level allocation
 * and returns. Reserve holds a unit for a patient; clinical need is unchanged.
 */
export default function EquipmentAllocation() {
  const { state, metrics, actions } = useHospital();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [pending, setPending] = useState(null);
  const [selected, setSelected] = useState(null);

  const pressureCases = useMemo(() => state.queue.filter((entry) => !entry.securedResources || !entry.securedResources.length), [state.queue]);
  const ventilatorCase = state.queue.find((entry) => entry.requiresVentilator) || pressureCases[0] || state.queue[0];
  const defaultCase = pressureCases[0] || state.queue[0];

  const categories = useMemo(() => {
    const term = query.trim().toLowerCase();
    return state.equipment
      .map((category) => ({ ...category, free: availableUnits(category).length, reservedCount: category.units.filter((unit) => unit.reserved).length }))
      .filter((category) => {
        const matchesTerm = !term || [category.name, category.location, category.description].filter(Boolean).some((field) => String(field).toLowerCase().includes(term));
        const computed = categoryStatus(category);
        const matchesStatus = status === 'all' || computed === status;
        return matchesTerm && matchesStatus;
      })
      .sort((a, b) => a.free - b.free);
  }, [state.equipment, query, status]);

  const totals = state.equipment.reduce(
    (accumulator, category) => ({
      total: accumulator.total + category.total,
      inUse: accumulator.inUse + category.inUse,
      reserved: accumulator.reserved + category.units.filter((unit) => unit.reserved).length,
      free: accumulator.free + availableUnits(category).length,
    }),
    { total: 0, inUse: 0, reserved: 0, free: 0 },
  );

  const underPressure = state.equipment.filter((category) => availableUnits(category).length <= 1);
  const activeFilters = (status !== 'all' ? 1 : 0) + (query ? 1 : 0);

  return (
    <div className="page">
      {underPressure.length ? (
        <div className="alert-line is-critical" role="status">
          <div className="alert-line-main">
            <span className="alert-line-title">{underPressure.length} equipment category(ies) with no free unit</span>
            <span className="alert-line-meta">
              {underPressure.map((category) => `${category.name} 0/${category.total}`).join(' · ')}
            </span>
          </div>
        </div>
      ) : null}

      <section className="kpi-row" aria-label="Equipment allocation">
        <KpiTile label="Equipment units" icon={Package} value={totals.total} caption={`${state.equipment.length} categories`} />
        <KpiTile label="Available" icon={Package} tone={totals.free <= 8 ? 'alert' : 'teal'} value={totals.free} caption={`${totals.reserved} held for cases`} />
        <KpiTile label="In use" icon={Package} value={totals.inUse} caption="Deployed to clinical areas" progress={Math.round((totals.inUse / Math.max(totals.total, 1)) * 100)} />
        <KpiTile label="Categories blocked" icon={Package} tone={underPressure.length ? 'alert' : 'teal'} value={underPressure.length} caption="No free unit right now" />
        <KpiTile label="Ventilators free" icon={Package} tone={metrics.equipment.ventilators.available <= 3 ? 'alert' : 'blue'} value={metrics.equipment.ventilators.available} caption={`${metrics.queue.ventilatorRequests} patients require ventilation`} />
        <KpiTile label="Utilisation" icon={Package} value={metrics.equipment.utilisation} suffix="%" caption="Across all categories" progress={metrics.equipment.utilisation} />
      </section>

      <Panel title="Equipment allocation" icon={Package} subtitle={`${categories.length} category(ies) shown · lowest availability first`}>
        <FilterBar
          search={<SearchBar value={query} onChange={setQuery} onClear={() => setQuery('')} placeholder="Search equipment or location…" label="Search equipment" id="equipment-allocation-search" />}
          filters={[
            {
              id: 'status',
              label: 'Status',
              value: status,
              onChange: setStatus,
              options: [
                { value: 'all', label: 'All statuses' },
                { value: 'Critical', label: 'No free unit' },
                { value: 'High', label: 'Under pressure' },
                { value: 'Available', label: 'Available' },
              ],
            },
          ]}
          activeCount={activeFilters}
          resultCount={categories.length}
          resultLabel="categories"
          onReset={() => {
            setQuery('');
            setStatus('all');
          }}
        />

        <div style={{ marginTop: 12 }}>
          <DataTable
            columns={[
              { key: 'name', header: 'Equipment', strong: true },
              { key: 'total', header: 'Total' },
              { key: 'free', header: 'Available' },
              { key: 'inUse', header: 'In use' },
              { key: 'status', header: 'Status', render: (row) => <StatusBadge status={categoryStatus(row)} label={categoryStatus(row) === 'Critical' ? 'No free unit' : categoryStatus(row) === 'High' ? 'Under pressure' : 'Available'} size="sm" /> },
              {
                key: 'actions',
                header: 'Actions',
                align: 'right',
                render: (row) => {
                  const unit = availableUnits(row)[0];
                  return (
                    <div className="row row-tight">
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => setSelected(row)}>
                        Review
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={!unit}
                        onClick={() => unit && actions.pushActivity(`${unit.id} (${row.name}) recommended for ${defaultCase ? defaultCase.id : 'standby'}`, 'info')}
                      >
                        Recommend
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={!unit}
                        onClick={() => unit && setPending({ action: 'reserve', category: row, unit, entry: row.id === 'ventilators' ? ventilatorCase : defaultCase })}
                      >
                        Allocate
                      </button>
                    </div>
                  );
                },
              },
            ]}
            rows={categories}
            getRowKey={(row) => row.id}
            emptyTitle="No equipment matches this view"
            emptyText="Change the status filter to see other categories."
          />
        </div>
      </Panel>

      <section className="grid-2">
        <Panel title="Category utilisation" icon={Package} subtitle="In use against total units">
          <div className="stack">
            {state.equipment.map((category) => (
              <UsageBar
                key={category.id}
                label={category.name}
                value={Math.round((category.inUse / Math.max(category.total, 1)) * 100)}
                tone={availableUnits(category).length === 0 ? 'alert' : availableUnits(category).length <= 2 ? 'teal' : 'success'}
                helper={`${availableUnits(category).length} free · ${category.inUse} in use · ${category.location}`}
              />
            ))}
          </div>
        </Panel>

        <Panel title="Units on hold" icon={Package} subtitle="Reserved units can be returned to the standby pool">
          <DataTable
            columns={[
              { key: 'unit', header: 'Unit', strong: true, render: (row) => <span className="mono">{row.unit.id}</span> },
              { key: 'category', header: 'Category' },
              { key: 'reservedFor', header: 'Held for', render: (row) => row.unit.reservedFor || '—' },
              {
                key: 'action',
                header: 'Action',
                align: 'right',
                render: (row) => (
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => actions.releaseEquipment(row.category.id, row.unit.id)}
                  >
                    Return
                  </button>
                ),
              },
            ]}
            rows={state.equipment.flatMap((category) =>
              category.units.filter((unit) => unit.reserved).map((unit) => ({ id: unit.id, unit, category })),
            )}
            getRowKey={(row) => row.id}
            emptyTitle="No units on hold"
            emptyText="Every reserved unit is currently deployed."
            compact
          />
        </Panel>
      </section>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.name}
        subtitle={selected?.location}
        size="md"
        badge={selected ? <StatusBadge status={categoryStatus(selected)} size="sm" /> : null}
      >
        {selected ? (
          <>
            <div className="stat-grid cols-3">
              <StatTile label="Total units" value={selected.total} />
              <StatTile label="Available" value={selected.free} tone={selected.free === 0 ? 'alert' : 'neutral'} />
              <StatTile label="On hold" value={selected.reservedCount} hint="Reserved for cases" />
            </div>
            <p className="text-small text-secondary">{selected.description}</p>
            {selected.criticalFor ? <p className="text-small text-secondary">Critical for: {selected.criticalFor}</p> : null}
            <DataTable
              columns={[
                { key: 'id', header: 'Unit', strong: true, render: (row) => <span className="mono">{row.id}</span> },
                { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} size="sm" /> },
                { key: 'reservedFor', header: 'Held for', render: (row) => row.reservedFor || '—' },
              ]}
              rows={selected.units}
              getRowKey={(row) => row.id}
              compact
            />
          </>
        ) : null}
      </DetailModal>

      <ConfirmationModal
        open={Boolean(pending)}
        title="Confirm equipment allocation"
        subtitle={pending ? `${pending.unit.id} (${pending.category.name}) → ${pending.entry ? pending.entry.id : 'standby pool'}` : ''}
        confirmLabel="Confirm allocation"
        onClose={() => setPending(null)}
        onConfirm={({ reason }) => {
          actions.reserveEquipment(pending.category.id, pending.unit.id, pending.entry ? pending.entry.id : 'standby');
          if (reason) actions.pushActivity(`Equipment note: ${reason}`, 'info');
          setPending(null);
        }}
        requireReason
        reasonLabel="Operational note"
        consequences={[
          `${pending?.unit?.id} is held for ${pending?.entry ? pending.entry.id : 'the standby pool'}.`,
          'Availability counters update for every role in real time.',
          'No unit is removed from an active clinical use.',
        ]}
        summary={
          pending ? (
            <div className="stat-grid cols-3">
              <StatTile label="Unit" value={pending.unit.id} hint={pending.category.name} />
              <StatTile label="Case" value={pending.entry ? pending.entry.id : 'Standby'} hint={pending.entry?.priority || ''} />
              <StatTile label="Free after" value={Math.max(0, availableUnits(pending.category).length - 1)} hint="Remaining units" />
            </div>
          ) : null
        }
      />
    </div>
  );
}
