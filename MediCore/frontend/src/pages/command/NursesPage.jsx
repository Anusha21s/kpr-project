import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import DataTable from '../../components/DataTable';
import StatusBadge from '../../components/StatusBadge';
import SearchBar from '../../components/SearchBar';
import FilterBar from '../../components/FilterBar';
import DetailModal from '../../components/DetailModal';
import StatTile from '../../components/StatTile';
import UsageBar from '../../components/UsageBar';
import { useHospital } from '../../hooks/useHospital';
import { NURSE_WORKLOAD_LIMIT, DEPARTMENT_ROSTER } from '../../data/nurses';

/**
 * Nurses (section 15) — same compact pattern as doctors:
 * nurse, department, duty, availability, workload.
 */
export default function NursesPage() {
  const { state, metrics } = useHospital();
  const [query, setQuery] = useState('');
  const [department, setDepartment] = useState('all');
  const [duty, setDuty] = useState('all');
  const [selected, setSelected] = useState(null);

  const departments = useMemo(
    () => Array.from(new Set(state.nurses.map((nurse) => nurse.department))).sort(),
    [state.nurses],
  );

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return state.nurses.filter((nurse) => {
      const matchesTerm =
        !term || [nurse.name, nurse.department, nurse.currentAssignment].filter(Boolean).some((field) => String(field).toLowerCase().includes(term));
      const matchesDepartment = department === 'all' || nurse.department === department;
      const matchesDuty = duty === 'all' ? true : duty === 'on' ? nurse.dutyStatus === 'ON_DUTY' : nurse.dutyStatus === 'OFF_DUTY';
      return matchesTerm && matchesDepartment && matchesDuty;
    });
  }, [state.nurses, query, department, duty]);

  const activeFilters = (department !== 'all' ? 1 : 0) + (duty !== 'all' ? 1 : 0) + (query ? 1 : 0);

  return (
    <div className="page">
      <section className="kpi-row" aria-label="Nursing roster">
        <KpiTile label="On duty" icon={Users} value={metrics.nurses.onDuty} caption={`of ${state.nurses.length} registered`} />
        <KpiTile label="Available" icon={Users} tone="teal" value={metrics.nurses.available} caption="Deployable now" />
        <KpiTile label="At workload limit" icon={Users} tone={metrics.nurses.atConstraint ? 'alert' : 'teal'} value={metrics.nurses.atConstraint} caption={`${NURSE_WORKLOAD_LIMIT}-patient constraint`} />
        <KpiTile label="Average load" icon={Users} value={metrics.nurses.averagePatients} caption={`Limit ${NURSE_WORKLOAD_LIMIT} per nurse`} progress={(metrics.nurses.averagePatients / NURSE_WORKLOAD_LIMIT) * 100} />
        <KpiTile label="Workload index" icon={Users} tone={metrics.nurses.workloadIndex >= 85 ? 'alert' : 'blue'} value={metrics.nurses.workloadIndex} suffix="%" caption="Across on-duty nurses" progress={metrics.nurses.workloadIndex} />
        <KpiTile label="High workload" icon={Users} tone={metrics.nurses.highWorkload ? 'alert' : 'teal'} value={metrics.nurses.highWorkload} caption="Nurses in the high band" />
      </section>

      <Panel
        title="Nursing roster"
        icon={Users}
        subtitle={`${rows.length} nurse(s) shown · assignments respect the workload constraint`}
        actions={
          <Link className="btn btn-outline btn-sm" to="/command/optimization">
            Assign cover
          </Link>
        }
      >
        <FilterBar
          search={<SearchBar value={query} onChange={setQuery} onClear={() => setQuery('')} placeholder="Search nurse or department…" label="Search nurses" id="nurse-search" />}
          filters={[
            { id: 'department', label: 'Department', value: department, onChange: setDepartment, options: [{ value: 'all', label: 'All departments' }, ...departments.map((entry) => ({ value: entry, label: entry }))] },
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
          resultLabel="nurses"
          onReset={() => {
            setQuery('');
            setDepartment('all');
            setDuty('all');
          }}
        />

        <div style={{ marginTop: 12 }}>
          <DataTable
            columns={[
              { key: 'name', header: 'Nurse', strong: true },
              { key: 'department', header: 'Department' },
              { key: 'dutyStatus', header: 'Duty', render: (row) => <StatusBadge status={row.dutyStatus} size="sm" /> },
              { key: 'availability', header: 'Availability', render: (row) => <StatusBadge status={row.availability} size="sm" /> },
              { key: 'workload', header: 'Workload', render: (row) => <StatusBadge status={row.workload} label={`${row.workload} · ${row.assignedPatients}/${NURSE_WORKLOAD_LIMIT}`} size="sm" /> },
            ]}
            rows={rows}
            getRowKey={(row) => row.id}
            onRowClick={(row) => setSelected(row)}
            emptyTitle="No nurses match this view"
            emptyText="Change the filters to see other staff."
          />
        </div>
      </Panel>

      <Panel title="Departmental load" icon={Users} subtitle={`Patients assigned against the departmental limit`}>
        <div className="stack">
          {DEPARTMENT_ROSTER.map((row) => (
            <UsageBar
              key={row.department}
              label={`${row.department} · ${row.assigned} nurses`}
              value={row.patientLoad}
              max={row.limit}
              tone={row.patientLoad >= row.limit ? 'alert' : row.patientLoad >= row.limit * 0.85 ? 'teal' : 'success'}
              showPercent={false}
              helper={`limit ${row.limit}`}
            />
          ))}
        </div>
      </Panel>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.name}
        subtitle={selected ? `${selected.department} · ${selected.shift}` : ''}
        badge={selected ? <><StatusBadge status={selected.dutyStatus} size="sm" /><StatusBadge status={selected.availability} size="sm" /></> : null}
        footer={selected ? <Link className="btn btn-primary" to="/command/optimization">Review deployment options</Link> : null}
      >
        {selected ? (
          <>
            <div className="stat-grid cols-3">
              <StatTile label="Assigned patients" value={`${selected.assignedPatients} / ${NURSE_WORKLOAD_LIMIT}`} hint="Workload constraint" tone={selected.assignedPatients >= NURSE_WORKLOAD_LIMIT ? 'alert' : 'neutral'} />
              <StatTile label="Workload" value={selected.workload} hint="Shift band" />
              <StatTile label="Duty" value={selected.dutyStatus === 'ON_DUTY' ? 'On duty' : 'Off duty'} hint={selected.shift} />
            </div>
            <div className="kv">
              <span className="kv-key">Current assignment</span>
              <span className="kv-value">{selected.currentAssignment || 'Unassigned'}</span>
            </div>
          </>
        ) : null}
      </DetailModal>
    </div>
  );
}
