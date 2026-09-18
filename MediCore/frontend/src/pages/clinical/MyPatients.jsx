import { useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import DataTable from '../../components/DataTable';
import StatusBadge from '../../components/StatusBadge';
import SearchBar from '../../components/SearchBar';
import FilterBar from '../../components/FilterBar';
import DetailModal from '../../components/DetailModal';
import StatTile from '../../components/StatTile';
import { useHospital } from '../../hooks/useHospital';
import { useAuth } from '../../hooks/useAuth';
import { getPatientsForUser } from '../../data/clinical';

/**
 * My Patients — compact rows, full clinical detail in the modal.
 */
export default function MyPatients() {
  const { state } = useHospital();
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [ward, setWard] = useState('all');
  const [priority, setPriority] = useState('all');
  const [selected, setSelected] = useState(null);

  const backendMine = state.myPatients || (state.patients ? state.patients.filter((p) => p.assignedDoctorId === user.staffRef || p.assignedNurseId === user.staffRef) : null);
  const mine = (backendMine && backendMine.length) ? backendMine : getPatientsForUser(user.staffRef);
  const wards = useMemo(() => Array.from(new Set(mine.map((patient) => patient.ward))).sort(), [mine]);

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return mine.filter((patient) => {
      const matchesTerm =
        !term || [patient.name, patient.id, patient.diagnosis, patient.bed].filter(Boolean).some((field) => String(field).toLowerCase().includes(term));
      const matchesWard = ward === 'all' || patient.ward === ward;
      const matchesPriority = priority === 'all' || patient.priority === priority;
      return matchesTerm && matchesWard && matchesPriority;
    });
  }, [mine, query, ward, priority]);

  const openTasks = (patient) =>
    (state.clinicalTasks ? Object.entries(state.clinicalTasks).filter(([, value]) => value.patientId === patient.id && value.status !== 'Completed').length : 0);

  const activeFilters = (ward !== 'all' ? 1 : 0) + (priority !== 'all' ? 1 : 0) + (query ? 1 : 0);

  return (
    <div className="page">
      <section className="kpi-row" aria-label="My patients">
        <KpiTile label="Under my care" icon={Users} value={mine.length} caption="This shift" />
        <KpiTile label="Critical" icon={Users} tone={mine.some((patient) => patient.priority === 'Critical') ? 'alert' : 'teal'} value={mine.filter((patient) => patient.priority === 'Critical').length} caption="Require close monitoring" />
        <KpiTile label="In ICU" icon={Users} value={mine.filter((patient) => patient.ward === 'ICU').length} caption={`${mine.filter((patient) => patient.ward === 'Ward').length} in ward beds`} />
        <KpiTile label="Ventilated" icon={Users} tone="alert" value={mine.filter((patient) => /ventilat/i.test(patient.diagnosis) || /ventilat/i.test(patient.plan)).length} caption="On ventilation support" />
        <KpiTile label="Tasks open" icon={Users} value={mine.reduce((total, patient) => total + openTasks(patient), 0)} caption="Across my patients" />
        <KpiTile label="Shift" icon={Users} tone="teal" value={state.meta.shift.label} caption={user.department} />
      </section>

      <Panel title="My patients" icon={Users} subtitle={`${rows.length} patient(s) shown · open a row for the full record`}>
        <FilterBar
          search={<SearchBar value={query} onChange={setQuery} onClear={() => setQuery('')} placeholder="Search patient, bed or diagnosis…" label="Search patients" id="my-patients-search" />}
          filters={[
            { id: 'ward', label: 'Ward', value: ward, onChange: setWard, options: [{ value: 'all', label: 'All wards' }, ...wards.map((entry) => ({ value: entry, label: entry }))] },
            {
              id: 'priority',
              label: 'Priority',
              value: priority,
              onChange: setPriority,
              options: [
                { value: 'all', label: 'All priorities' },
                { value: 'Critical', label: 'Critical' },
                { value: 'High', label: 'High' },
                { value: 'Medium', label: 'Medium' },
              ],
            },
          ]}
          activeCount={activeFilters}
          resultCount={rows.length}
          resultLabel="patients"
          onReset={() => {
            setQuery('');
            setWard('all');
            setPriority('all');
          }}
        />

        <div style={{ marginTop: 12 }}>
          <DataTable
            columns={[
              { key: 'bed', header: 'Bed', strong: true, render: (row) => <span className="mono">{row.bed}</span> },
              { key: 'name', header: 'Patient' },
              { key: 'diagnosis', header: 'Diagnosis' },
              { key: 'priority', header: 'Priority', render: (row) => <StatusBadge status={row.priority} size="sm" /> },
              { key: 'status', header: 'Status' },
            ]}
            rows={rows}
            getRowKey={(row) => row.id}
            onRowClick={(row) => setSelected(row)}
            emptyTitle="No patients match this view"
            emptyText="Change the filters to see other patients."
          />
        </div>
      </Panel>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.name} · ${selected.id}` : ''}
        subtitle={selected ? `${selected.age}y ${selected.sex} · ${selected.bed} · admitted ${selected.admitted}` : ''}
        size="lg"
        badge={selected ? <StatusBadge status={selected.priority} size="sm" /> : null}
      >
        {selected ? (
          <>
            <div className="stat-grid cols-3">
              <StatTile label="Diagnosis" value={selected.diagnosis} />
              <StatTile label="Status" value={selected.status} />
              <StatTile label="Plan" value={selected.plan} />
            </div>

            <Panel title="Latest vitals" icon={Users} compact>
              <div className="stat-grid cols-3">
                <StatTile label="Heart rate" value={`${selected.vitals.heartRate} bpm`} />
                <StatTile label="Blood pressure" value={selected.vitals.bp} />
                <StatTile label="SpO₂" value={`${selected.vitals.spo2}%`} tone={selected.vitals.spo2 < 95 ? 'alert' : 'neutral'} />
                <StatTile label="Temperature" value={selected.vitals.temp} />
                <StatTile label="Respiratory rate" value={`${selected.vitals.respiratoryRate}/min`} />
                <StatTile label="Bed" value={selected.bed} hint={selected.ward} />
              </div>
            </Panel>

            <Panel title="Care team" icon={Users} compact>
              <div className="row row-tight">
                {selected.assignedDoctors.map((ref) => (
                  <span className="badge badge-neutral text-xs" key={ref}>
                    {ref}
                  </span>
                ))}
                {selected.assignedNurses.map((ref) => (
                  <span className="badge badge-info text-xs" key={ref}>
                    {ref}
                  </span>
                ))}
              </div>
            </Panel>

            <Panel title="Open tasks" icon={Users} compact>
              <ul className="rationale-list">
                {selected.tasks.map((task) => (
                  <li key={task}>{task}</li>
                ))}
              </ul>
            </Panel>
          </>
        ) : null}
      </DetailModal>
    </div>
  );
}
