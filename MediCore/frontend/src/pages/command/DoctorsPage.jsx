import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Stethoscope, UserCheck } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import DataTable from '../../components/DataTable';
import StatusBadge from '../../components/StatusBadge';
import SearchBar from '../../components/SearchBar';
import FilterBar from '../../components/FilterBar';
import DetailModal from '../../components/DetailModal';
import StatTile from '../../components/StatTile';
import { useHospital } from '../../hooks/useHospital';
import { SPECIALTY_COVERAGE } from '../../data/doctors';
import { isDoctorEligible } from '../../utils/simulationEngine';

/**
 * Doctors (section 14) — compact operational rows: specialty, duty,
 * availability, current load. No biographies.
 */
export default function DoctorsPage() {
  const { state, metrics } = useHospital();
  const [query, setQuery] = useState('');
  const [specialty, setSpecialty] = useState('all');
  const [duty, setDuty] = useState('all');
  const [selected, setSelected] = useState(null);

  const specialties = useMemo(
    () => Array.from(new Set(state.doctors.map((doctor) => doctor.specialty))).sort(),
    [state.doctors],
  );

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return state.doctors.filter((doctor) => {
      const matchesTerm =
        !term ||
        [doctor.name, doctor.specialty, doctor.currentAssignment].filter(Boolean).some((field) =>
          String(field).toLowerCase().includes(term),
        );
      const matchesSpecialty = specialty === 'all' || doctor.specialty === specialty;
      const matchesDuty =
        duty === 'all' ? true : duty === 'on' ? doctor.dutyStatus === 'ON_DUTY' : doctor.dutyStatus === 'OFF_DUTY';
      return matchesTerm && matchesSpecialty && matchesDuty;
    });
  }, [state.doctors, query, specialty, duty]);

  const shortfalls = SPECIALTY_COVERAGE.filter((row) => row.available < row.required);
  const activeFilters = (specialty !== 'all' ? 1 : 0) + (duty !== 'all' ? 1 : 0) + (query ? 1 : 0);

  return (
    <div className="page">
      <section className="kpi-row" aria-label="Medical roster">
        <KpiTile label="On duty" icon={Stethoscope} value={metrics.doctors.onDuty} caption={`of ${state.doctors.length} registered`} />
        <KpiTile label="Available" icon={UserCheck} tone="teal" value={metrics.doctors.available} caption="Deployable now" />
        <KpiTile label="In procedure" icon={Stethoscope} value={metrics.doctors.busy} caption="Busy — not assignable" />
        <KpiTile label="Off duty" icon={Stethoscope} value={metrics.doctors.offDuty} caption="Outside shift window" />
        <KpiTile label="Workload index" icon={Stethoscope} tone={metrics.doctors.workloadIndex >= 85 ? 'alert' : 'blue'} value={metrics.doctors.workloadIndex} suffix="%" caption="Across on-duty doctors" progress={metrics.doctors.workloadIndex} />
        <KpiTile label="Specialty gaps" icon={Stethoscope} tone={shortfalls.length ? 'alert' : 'teal'} value={shortfalls.length} caption={shortfalls.length ? shortfalls.map((row) => row.specialty).join(', ') : 'Coverage complete'} />
      </section>

      <Panel
        title="Medical roster"
        icon={Stethoscope}
        subtitle={`${rows.length} doctor(s) shown · eligibility rule applied to recommendations`}
        actions={
          <Link className="btn btn-outline btn-sm" to="/command/optimization">
            Staffing options
          </Link>
        }
      >
        <FilterBar
          search={<SearchBar value={query} onChange={setQuery} onClear={() => setQuery('')} placeholder="Search name or specialty…" label="Search doctors" id="doctor-search" />}
          filters={[
            { id: 'specialty', label: 'Specialty', value: specialty, onChange: setSpecialty, options: [{ value: 'all', label: 'All specialties' }, ...specialties.map((entry) => ({ value: entry, label: entry }))] },
            {
              id: 'duty',
              label: 'Duty',
              value: duty,
              onChange: setDuty,
              options: [
                { value: 'all', label: 'All' },
                { value: 'on', label: 'On duty' },
                { value: 'off', label: 'Off duty' },
              ],
            },
          ]}
          activeCount={activeFilters}
          resultCount={rows.length}
          resultLabel="doctors"
          onReset={() => {
            setQuery('');
            setSpecialty('all');
            setDuty('all');
          }}
        />

        <div style={{ marginTop: 12 }}>
          <DataTable
            columns={[
              { key: 'name', header: 'Doctor', strong: true },
              { key: 'specialty', header: 'Specialty' },
              { key: 'dutyStatus', header: 'Duty', render: (row) => <StatusBadge status={row.dutyStatus} size="sm" /> },
              { key: 'availability', header: 'Availability', render: (row) => <StatusBadge status={row.availability} size="sm" /> },
              { key: 'workload', header: 'Load', render: (row) => <StatusBadge status={row.workload} label={row.workload} size="sm" /> },
              { key: 'patients', header: 'Patients', render: (row) => row.patients },
            ]}
            rows={rows}
            getRowKey={(row) => row.id}
            onRowClick={(row) => setSelected(row)}
            emptyTitle="No doctors match this view"
            emptyText="Change the filters to see other staff."
          />
        </div>
      </Panel>

      <Panel title="Specialty coverage" icon={Stethoscope} subtitle="Available doctors against required cover">
        <DataTable
          columns={[
            { key: 'specialty', header: 'Specialty', strong: true },
            { key: 'required', header: 'Required' },
            { key: 'available', header: 'Available' },
            {
              key: 'status',
              header: 'Coverage',
              render: (row) => <StatusBadge status={row.available < row.required ? 'Critical' : 'Available'} label={row.available < row.required ? `Short ${row.required - row.available}` : 'Covered'} size="sm" />,
            },
          ]}
          rows={SPECIALTY_COVERAGE}
          getRowKey={(row) => row.specialty}
          compact
        />
      </Panel>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.name}
        subtitle={selected ? `${selected.specialty} · ${selected.shift}` : ''}
        badge={
          selected ? (
            <>
              <StatusBadge status={selected.dutyStatus} size="sm" />
              <StatusBadge status={selected.availability} size="sm" />
            </>
          ) : null
        }
        footer={
          selected ? (
            <Link className="btn btn-primary" to="/command/optimization">
              Review staffing options
            </Link>
          ) : null
        }
      >
        {selected ? (
          <>
            <div className="stat-grid cols-3">
              <StatTile label="Patients" value={selected.patients} hint="Currently under care" />
              <StatTile label="Workload" value={selected.workload} hint="Shift band" />
              <StatTile label="Eligible" value={isDoctorEligible(selected) ? 'Yes' : 'No'} hint="Specialty · shift · duty · availability" tone={isDoctorEligible(selected) ? 'success' : 'alert'} />
            </div>
            <div className="kv">
              <span className="kv-key">Current assignment</span>
              <span className="kv-value">{selected.currentAssignment}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Shift window</span>
              <span className="kv-value">{selected.shift}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Contact</span>
              <span className="kv-value">{selected.contact}</span>
            </div>
          </>
        ) : null}
      </DetailModal>
    </div>
  );
}
