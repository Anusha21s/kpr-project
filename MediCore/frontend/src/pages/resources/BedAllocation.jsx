import { useMemo, useState } from 'react';
import { BedDouble } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import DataTable from '../../components/DataTable';
import StatusBadge from '../../components/StatusBadge';
import SearchBar from '../../components/SearchBar';
import FilterBar from '../../components/FilterBar';
import ConfirmationModal from '../../components/ConfirmationModal';
import DetailModal from '../../components/DetailModal';
import StatTile from '../../components/StatTile';
import { useHospital } from '../../hooks/useHospital';
import { selectQueueCandidatesForResource } from '../../utils/hospitalState';
import { BED_STATUS } from '../../data/beds';

const BED_TYPE_BY_WARD = { icu: 'ICU Bed', emergency: 'Emergency Bed', general: 'General Bed', maternity: 'General Bed' };

/**
 * Bed Allocation (section 21) — one row per allocatable bed with the candidate
 * the queue suggests, the reason, and Review / Recommend / Confirm.
 */
export default function BedAllocation() {
  const { state, metrics, actions } = useHospital();
  const [query, setQuery] = useState('');
  const [ward, setWard] = useState('all');
  const [pending, setPending] = useState(null);
  const [selected, setSelected] = useState(null);

  const candidateFor = (bed) => {
    const candidates = selectQueueCandidatesForResource(state.queue, BED_TYPE_BY_WARD[bed.wardId]);
    if (!candidates.length) return null;
    const top = candidates[0];
    const held = bed.heldFor && bed.heldFor.includes(top.id);
    return {
      ...top,
      reason: held
        ? `Provisional hold already placed for this case (${bed.heldFor}). Highest priority waiting for this resource.`
        : `${top.priority} priority, waiting ${top.waitingMinutes} min. Requirement recorded by ${top.clinicalRequirementBy || 'the clinical team'}.`,
    };
  };

  const beds = useMemo(() => {
    const term = query.trim().toLowerCase();
    return state.bedUnits
      .filter((unit) => {
        const matchesTerm = !term || [unit.id, unit.ward, unit.bedType, unit.patient].filter(Boolean).some((field) => String(field).toLowerCase().includes(term));
        const matchesWard = ward === 'all' || unit.wardId === ward;
        return matchesTerm && matchesWard;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [state.bedUnits, query, ward]);

  const allocatable = state.bedUnits.filter((unit) => unit.status === BED_STATUS.AVAILABLE || unit.status === BED_STATUS.RESERVED);
  const awaiting = state.queue.filter((entry) => ['General Bed', 'ICU Bed', 'Emergency Bed'].includes(entry.requiredResource));
  const activeFilters = (ward !== 'all' ? 1 : 0) + (query ? 1 : 0);

  return (
    <div className="page">
      <section className="kpi-row" aria-label="Bed allocation">
        <KpiTile label="Allocatable beds" icon={BedDouble} value={allocatable.length} caption={`${state.bedUnits.filter((unit) => unit.status === 'Available').length} vacant · ${state.bedUnits.filter((unit) => unit.status === 'Reserved').length} held`} />
        <KpiTile label="Awaiting a bed" icon={BedDouble} tone={awaiting.length ? 'alert' : 'teal'} value={awaiting.length} caption="Requirement recorded" />
        <KpiTile label="ICU vacant" icon={BedDouble} tone={metrics.beds.icu.available <= 1 ? 'alert' : 'teal'} value={metrics.beds.icu.available} caption={`${metrics.queue.icuRequests} ICU requests`} />
        <KpiTile label="General available" icon={BedDouble} value={metrics.beds.general.available} caption={`of ${metrics.beds.general.total} general beds`} />
        <KpiTile label="Placements confirmed" icon={BedDouble} tone="teal" value={state.allocations.length} caption="This session" />
        <KpiTile label="Occupancy" icon={BedDouble} value={metrics.beds.occupancyPercentage} suffix="%" caption={`${metrics.beds.committed} of ${metrics.beds.total} committed`} progress={metrics.beds.occupancyPercentage} />
      </section>

      <Panel
        title="Bed allocation board"
        icon={BedDouble}
        subtitle={`${beds.length} bed(s) shown · recommendations come from the patient queue`}
      >
        <FilterBar
          search={<SearchBar value={query} onChange={setQuery} onClear={() => setQuery('')} placeholder="Search bed ID or patient…" label="Search beds" id="bed-allocation-search" />}
          filters={[
            {
              id: 'ward',
              label: 'Ward',
              value: ward,
              onChange: setWard,
              options: [{ value: 'all', label: 'All wards' }, ...metrics.beds.wards.map((entry) => ({ value: entry.id, label: entry.name }))],
            },
          ]}
          activeCount={activeFilters}
          resultCount={beds.length}
          resultLabel="beds"
          onReset={() => {
            setQuery('');
            setWard('all');
          }}
        />

        <div style={{ marginTop: 12 }}>
          <DataTable
            columns={[
              { key: 'id', header: 'Bed', strong: true, render: (row) => <span className="mono">{row.id}</span> },
              { key: 'ward', header: 'Ward' },
              { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} size="sm" /> },
              {
                key: 'candidate',
                header: 'Candidate',
                render: (row) => {
                  const candidate = candidateFor(row);
                  if (!candidate) return <span className="text-secondary">No patient waiting</span>;
                  return (
                    <span className="row row-tight">
                      <span className="mono">{candidate.id}</span>
                      <StatusBadge status={candidate.priority} size="sm" />
                    </span>
                  );
                },
              },
              {
                key: 'actions',
                header: 'Actions',
                align: 'right',
                render: (row) => {
                  const candidate = candidateFor(row);
                  const busy = row.status === 'Occupied';
                  return (
                    <div className="row row-tight">
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => setSelected({ bed: row, candidate })}>
                        Review
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={!candidate}
                        onClick={() => candidate && actions.pushActivity(`Bed ${row.id} recommended for ${candidate.id}`, 'info')}
                      >
                        Recommend
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy || !candidate}
                        onClick={() => candidate && setPending({ bed: row, candidate })}
                      >
                        Confirm
                      </button>
                    </div>
                  );
                },
              },
            ]}
            rows={beds}
            getRowKey={(row) => row.id}
            emptyTitle="No beds match this view"
            emptyText="Change the ward filter to see other beds."
          />
        </div>
      </Panel>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `Bed ${selected.bed.id}` : ''}
        subtitle={selected ? `${selected.bed.ward} · ${selected.bed.bedType}` : ''}
        size="md"
        badge={selected ? <StatusBadge status={selected.bed.status} size="sm" /> : null}
        footer={
          selected?.candidate ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setPending(selected);
                setSelected(null);
              }}
              disabled={selected.bed.status === 'Occupied'}
            >
              Confirm allocation
            </button>
          ) : null
        }
      >
        {selected ? (
          <>
            <div className="stat-grid cols-3">
              <StatTile label="Status" value={selected.bed.status} hint={selected.bed.patient ? `Patient ${selected.bed.patient}` : 'No patient'} />
              <StatTile label="Held for" value={selected.bed.heldFor || '—'} hint="Provisional hold" />
              <StatTile label="Ward" value={selected.bed.ward} />
            </div>
            {selected.candidate ? (
              <>
                <div className="kv">
                  <span className="kv-key">Candidate</span>
                  <span className="kv-value mono">{selected.candidate.id}</span>
                </div>
                <div className="kv">
                  <span className="kv-key">Requires</span>
                  <span className="kv-value">{selected.candidate.requiredResource}</span>
                </div>
                <p className="text-small text-secondary">{selected.candidate.reason}</p>
              </>
            ) : (
              <p className="empty-line">No patient is waiting for this bed type.</p>
            )}
            <div className="row row-tight">
              {selected.bed.features.map((feature) => (
                <span className="badge badge-neutral text-xs" key={feature}>
                  {feature}
                </span>
              ))}
            </div>
          </>
        ) : null}
      </DetailModal>

      <ConfirmationModal
        open={Boolean(pending)}
        title="Confirm bed allocation"
        subtitle={pending ? `${pending.bed.id} → ${pending.candidate.id} · ${pending.candidate.priority} priority` : ''}
        confirmLabel="Confirm allocation"
        onClose={() => setPending(null)}
        onConfirm={({ reason }) => {
          actions.confirmBedAllocation(pending.bed.id, pending.candidate.id, pending.bed.bedType);
          actions.pushActivity(`${pending.bed.id} allocated to ${pending.candidate.id}${reason ? ` — ${reason}` : ''}`, 'success');
          setPending(null);
        }}
        requireReason
        reasonLabel="Operational note"
        consequences={[
          `${pending?.bed?.id} becomes reserved for ${pending?.candidate?.id}.`,
          'The clinical team and command center see the updated bed state immediately.',
          'No patient is moved and no other patient’s care is altered.',
        ]}
        summary={
          pending ? (
            <div className="stack-sm">
              <div className="stat-grid cols-3">
                <StatTile label="Patient" value={pending.candidate.id} hint={pending.candidate.triage} />
                <StatTile label="Waiting" value={`${pending.candidate.waitingMinutes} min`} />
                <StatTile label="Requires" value={pending.candidate.requiredResource} />
              </div>
              <p className="text-small text-secondary">{pending.candidate.reason}</p>
            </div>
          ) : null
        }
      />
    </div>
  );
}
