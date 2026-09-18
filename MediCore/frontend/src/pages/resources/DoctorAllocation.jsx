import { useMemo, useState } from 'react';
import { Stethoscope } from 'lucide-react';
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

/**
 * Doctor Allocation (section 21) — eligibility is split into its three real
 * conditions (specialty match, on shift, not unavailable) and a case can be
 * recommended or confirmed. Coverage gaps are shown before load is raised.
 */
export default function DoctorAllocation() {
  const { state, metrics, actions } = useHospital();
  const [query, setQuery] = useState('');
  const [specialty, setSpecialty] = useState('all');
  const [pending, setPending] = useState(null);
  const [selected, setSelected] = useState(null);

  const specialties = useMemo(() => Array.from(new Set(state.doctors.map((doctor) => doctor.specialty))).sort(), [state.doctors]);

  const openCases = useMemo(
    () => state.queue.filter((entry) => !entry.assignedDoctor).sort((a, b) => b.waitingMinutes - a.waitingMinutes),
    [state.queue],
  );

  const unassigned = state.queue.filter((entry) => !entry.assignedDoctor);
  /* Coverage gap = a specialty the queue is asking for with no on-duty doctor
     eligible under the engine's rule (specialty match + on duty + available). */
  const coverageGaps = Array.from(
    state.queue.reduce((gaps, entry) => {
      const eligible = state.doctors.some(
        (doctor) =>
          doctor.specialty === entry.specialtyRequired &&
          doctor.dutyStatus === 'ON_DUTY' &&
          doctor.availability === 'Available' &&
          doctor.shiftBlock === state.meta.shift.id,
      );
      if (!eligible) gaps.set(entry.specialtyRequired, (gaps.get(entry.specialtyRequired) || 0) + 1);
      return gaps;
    }, new Map()),
  ).map(([specialty, count]) => ({ specialty, count }));
  const shiftBlocks = Array.from(new Set(state.doctors.map((doctor) => doctor.shiftBlock)));

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return state.doctors
      .filter((doctor) => {
        const matchesTerm = !term || [doctor.name, doctor.id, doctor.specialty, doctor.currentAssignment].filter(Boolean).some((field) => String(field).toLowerCase().includes(term));
        const matchesSpecialty = specialty === 'all' || doctor.specialty === specialty;
        return matchesTerm && matchesSpecialty;
      })
      .sort((a, b) => a.workload - b.workload);
  }, [state.doctors, query, specialty]);

  /* Same eligibility rule the optimisation engine applies: specialty match,
     inside the duty block, marked on duty and available for a new assignment. */
  const breakdownFor = (doctor, entry) => {
    if (!entry) return ['No unassigned case in the queue.'];
    const inShift = doctor.shiftBlock === state.meta.shift.id;
    return [
      doctor.specialty === entry.specialtyRequired
        ? 'Specialty matches the case requirement.'
        : `Specialty differs from the required ${entry.specialtyRequired}.`,
      inShift ? 'Within the current duty block.' : `Outside the current duty block (${doctor.shiftBlock}).`,
      doctor.dutyStatus === 'ON_DUTY' ? 'Marked on duty.' : 'Marked off duty.',
      doctor.availability === 'Available' ? 'Available for a new assignment.' : `Availability: ${doctor.availability}.`,
      `Current load ${doctor.workload.toLowerCase()} across ${doctor.patients} patient(s).`,
    ];
  };

  const activeFilters = (specialty !== 'all' ? 1 : 0) + (query ? 1 : 0);

  return (
    <div className="page">
      <section className="kpi-row" aria-label="Doctor allocation">
        <KpiTile label="On duty" icon={Stethoscope} value={metrics.doctors.onDuty} caption={`of ${state.doctors.length} doctors rostered`} />
        <KpiTile label="Available" icon={Stethoscope} tone={metrics.doctors.available <= 3 ? 'alert' : 'teal'} value={metrics.doctors.available} caption="Ready for assignment" />
        <KpiTile label="Specialties with no cover" icon={Stethoscope} tone={coverageGaps.length ? 'alert' : 'teal'} value={coverageGaps.length} caption="Requesting specialties without an eligible doctor" />
        <KpiTile label="Unassigned cases" icon={Stethoscope} tone={unassigned.length ? 'alert' : 'teal'} value={unassigned.length} caption="No doctor assigned yet" />
        <KpiTile label="Workload index" icon={Stethoscope} value={metrics.doctors.workloadIndex} suffix="%" caption="Across doctors on duty" progress={metrics.doctors.workloadIndex} />
        <KpiTile label="Out of shift" icon={Stethoscope} value={state.doctors.filter((doctor) => !doctor.shiftBlock.includes(state.meta.shift.label.split('–')[0].trim())).length} caption="Between duty blocks" />
      </section>

      <Panel title="Doctor allocation" icon={Stethoscope} subtitle={`${rows.length} doctor(s) shown · lowest load first · eligibility follows specialty and duty rules`}>
        <FilterBar
          search={<SearchBar value={query} onChange={setQuery} onClear={() => setQuery('')} placeholder="Search doctor or specialty…" label="Search doctors" id="doctor-allocation-search" />}
          filters={[
            { id: 'specialty', label: 'Specialty', value: specialty, onChange: setSpecialty, options: [{ value: 'all', label: 'All specialties' }, ...specialties.map((entry) => ({ value: entry, label: entry }))] },
          ]}
          activeCount={activeFilters}
          resultCount={rows.length}
          resultLabel="doctors"
          onReset={() => {
            setQuery('');
            setSpecialty('all');
          }}
        />

        <div style={{ marginTop: 12 }}>
          <DataTable
            columns={[
              { key: 'name', header: 'Doctor', strong: true, render: (row) => `${row.name} · ${row.id}` },
              { key: 'specialty', header: 'Specialty' },
              { key: 'dutyStatus', header: 'Duty', render: (row) => <StatusBadge status={row.dutyStatus} size="sm" /> },
              { key: 'availability', header: 'Availability', render: (row) => <StatusBadge status={row.availability} size="sm" /> },
              { key: 'workload', header: 'Current load', render: (row) => `${row.workload}%` },
              {
                key: 'actions',
                header: 'Actions',
                align: 'right',
                render: (row) => {
                  const entry = openCases[0];
                  const eligible =
                    Boolean(entry) &&
                    row.specialty === entry.specialtyRequired &&
                    row.shiftBlock === state.meta.shift.id &&
                    row.dutyStatus === 'ON_DUTY' &&
                    row.availability === 'Available';
                  return (
                    <div className="row row-tight">
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => setSelected({ doctor: row, entry })}>
                        Review
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={!entry}
                        onClick={() => entry && actions.pushActivity(`${row.name} recommended for ${entry.id}`, 'info')}
                      >
                        Recommend
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={!eligible}
                        title={eligible ? 'Confirm assignment' : 'Eligibility conditions not met'}
                        onClick={() => entry && setPending({ doctor: row, entry })}
                      >
                        Assign
                      </button>
                    </div>
                  );
                },
              },
            ]}
            rows={rows}
            getRowKey={(row) => row.id}
            emptyTitle="No doctors match this view"
            emptyText="Change the specialty filter to see other doctors."
          />
        </div>
      </Panel>

      <section className="grid-2">
        <Panel title="Cases awaiting a doctor" icon={Stethoscope} subtitle={`${openCases.length} case(s) in the emergency queue`}>
          <DataTable
            columns={[
              { key: 'id', header: 'Patient', strong: true, render: (row) => <span className="mono">{row.id}</span> },
              { key: 'priority', header: 'Priority', render: (row) => <StatusBadge status={row.priority} size="sm" /> },
              { key: 'specialtyRequired', header: 'Specialty' },
              { key: 'waitingMinutes', header: 'Waiting', render: (row) => `${row.waitingMinutes} min` },
            ]}
            rows={openCases.slice(0, 6)}
            getRowKey={(row) => row.id}
            onRowClick={(row) => setSelected({ doctor: rows[0], entry: row })}
            emptyTitle="No unassigned cases"
            emptyText="Every queued patient already has a doctor assigned."
            compact
          />
        </Panel>

        <Panel title="Coverage gaps" icon={Stethoscope} subtitle="Requesting specialties without an eligible doctor">
          <ul className="conflict-list">
            {coverageGaps.length ? (
              coverageGaps.map((entry) => (
                <li key={entry.specialty}>
                  <span className="status-dot is-alert" aria-hidden="true" />
                  <span className="conflict-list-text">
                    <span className="conflict-list-title">{entry.specialty}</span>
                    <span className="conflict-list-meta">{entry.count} request(s) waiting · no on-duty doctor in this specialty</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => actions.pushActivity(`Coverage gap escalated — ${entry.specialty} has no eligible on-duty doctor`, 'alert')}
                  >
                    Escalate
                  </button>
                </li>
              ))
            ) : (
              <li>
                <span className="status-dot is-ok" aria-hidden="true" />
                <span className="conflict-list-text">
                  <span className="conflict-list-title">All requesting specialties have cover</span>
                  <span className="conflict-list-meta">{shiftBlocks.join(' · ')}</span>
                </span>
              </li>
            )}
          </ul>
        </Panel>
      </section>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.doctor ? `${selected.doctor.name} · ${selected.doctor.id}` : ''}
        subtitle={selected?.doctor ? `${selected.doctor.specialty} · ${selected.doctor.shift}` : ''}
        size="md"
        badge={selected?.doctor ? <StatusBadge status={selected.doctor.availability} size="sm" /> : null}
      >
        {selected?.doctor ? (
          <>
            <div className="stat-grid cols-3">
              <StatTile label="Duty" value={selected.doctor.dutyStatus} hint={selected.doctor.shiftBlock} />
              <StatTile label="Load" value={`${selected.doctor.workload}%`} hint={`${selected.doctor.patients} patient(s)`} tone={selected.doctor.workload >= 85 ? 'alert' : 'neutral'} />
              <StatTile label="Since" value={selected.doctor.since || '—'} hint="Current status" />
            </div>
            <div className="kv">
              <span className="kv-key">Current assignment</span>
              <span className="kv-value">{selected.doctor.currentAssignment}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Proposed case</span>
              <span className="kv-value">{selected.entry ? `${selected.entry.id} · ${selected.entry.priority} · ${selected.entry.specialtyRequired}` : 'No unassigned case'}</span>
            </div>
            <Panel title="Eligibility check" icon={Stethoscope} compact>
              <ul className="rationale-list">
                {breakdownFor(selected.doctor, selected.entry).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Panel>
          </>
        ) : null}
      </DetailModal>

      <ConfirmationModal
        open={Boolean(pending)}
        title="Confirm doctor assignment"
        subtitle={pending ? `${pending.entry.id} → ${pending.doctor.name}` : ''}
        confirmLabel="Confirm assignment"
        onClose={() => setPending(null)}
        onConfirm={({ reason }) => {
          actions.assignDoctor(pending.entry.id, pending.doctor.id);
          actions.pushActivity(`${pending.doctor.name} assigned to ${pending.entry.id} by the resource coordinator${reason ? ` — ${reason}` : ''}`, 'success');
          setPending(null);
        }}
        requireReason
        reasonLabel="Operational note"
        consequences={[
          `${pending?.doctor?.name} is added to the care team for ${pending?.entry?.id}.`,
          'Clinical ownership of treatment decisions is unchanged.',
          'No other patient’s assignment is altered.',
        ]}
        summary={
          pending ? (
            <div className="stat-grid cols-3">
              <StatTile label="Case" value={pending.entry.id} hint={pending.entry.triage} />
              <StatTile label="Priority" value={pending.entry.priority} tone={pending.entry.priority === 'Critical' ? 'alert' : 'neutral'} />
              <StatTile label="Doctor load" value={`${pending.doctor.workload}%`} hint={`${pending.doctor.patients} patient(s)`} />
            </div>
          ) : null
        }
      />
    </div>
  );
}
