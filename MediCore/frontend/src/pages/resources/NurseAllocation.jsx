import { useMemo, useState } from 'react';
import { Users } from 'lucide-react';
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
import { NURSE_WORKLOAD_LIMIT } from '../../data/nurses';

const DEPARTMENT_UNITS = {
  ICU: 'ICU',
  Emergency: 'Emergency',
  'General Ward': 'General Ward',
  'OT Complex': 'Theatre complex',
  'Maternity & Paediatrics': 'Maternity & Paediatrics',
};

/**
 * Nurse Allocation (section 21) — nursing capacity and the configured workload
 * constraint. Reinforcement is recommended, then confirmed; nothing is forced.
 */
export default function NurseAllocation() {
  const { state, metrics, actions } = useHospital();
  const [query, setQuery] = useState('');
  const [department, setDepartment] = useState('ICU');
  const [pending, setPending] = useState(null);
  const [selected, setSelected] = useState(null);

  const departments = useMemo(() => Array.from(new Set(state.nurses.map((nurse) => nurse.department))).sort(), [state.nurses]);

  const departmentRows = departments.map((name) => {
    const members = state.nurses.filter((nurse) => nurse.department === name);
    return {
      id: name,
      name,
      staffed: members.filter((nurse) => nurse.dutyStatus === 'ON_DUTY').length,
      available: members.filter((nurse) => nurse.availability === 'Available').length,
      atConstraint: members.filter((nurse) => nurse.assignedPatients >= NURSE_WORKLOAD_LIMIT).length,
      load: Math.round((members.reduce((total, nurse) => total + nurse.assignedPatients, 0) / Math.max(members.length * NURSE_WORKLOAD_LIMIT, 1)) * 100),
      unit: DEPARTMENT_UNITS[name] || name,
    };
  });

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return state.nurses
      .filter((nurse) => {
        const matchesTerm = !term || [nurse.name, nurse.id, nurse.department, nurse.currentAssignment].filter(Boolean).some((field) => String(field).toLowerCase().includes(term));
        const matchesDepartment = department === 'all' || nurse.department === department;
        return matchesTerm && matchesDepartment;
      })
      .sort((a, b) => a.assignedPatients - b.assignedPatients);
  }, [state.nurses, query, department]);

  const deployable = state.nurses.filter((nurse) => nurse.availability === 'Available' && nurse.dutyStatus === 'ON_DUTY');
  const targetDepartment = departmentRows.find((entry) => entry.name === department) || departmentRows[0];
  const targetCase = state.queue.find((entry) => entry.priority === 'Critical') || state.queue[0];
  const activeFilters = (department !== 'all' ? 1 : 0) + (query ? 1 : 0);

  return (
    <div className="page">
      <section className="kpi-row" aria-label="Nurse allocation">
        <KpiTile label="On duty" icon={Users} value={metrics.nurses.onDuty} caption={`of ${state.nurses.length} nurses rostered`} />
        <KpiTile label="Deployable" icon={Users} tone={deployable.length <= 4 ? 'alert' : 'teal'} value={deployable.length} caption="Available and on duty" />
        <KpiTile label="At workload limit" icon={Users} tone={metrics.nurses.atConstraint ? 'alert' : 'teal'} value={metrics.nurses.atConstraint} caption={`${NURSE_WORKLOAD_LIMIT}-patient constraint reached`} />
        <KpiTile label="Average patients" icon={Users} value={metrics.nurses.averagePatients} caption={`Constraint is ${NURSE_WORKLOAD_LIMIT} per nurse`} progress={Math.round((metrics.nurses.averagePatients / NURSE_WORKLOAD_LIMIT) * 100)} />
        <KpiTile label="ICU cover" icon={Users} tone={metrics.pressure.byId.icu.pressure >= 85 ? 'alert' : 'blue'} value={departmentRows.find((entry) => entry.name === 'ICU')?.staffed || 0} caption={`${metrics.beds.icu.occupied} ICU beds occupied`} />
        <KpiTile label="Reinforcement needed" icon={Users} tone={metrics.nurses.atConstraint ? 'alert' : 'teal'} value={Math.max(0, Math.ceil(metrics.nurses.atConstraint / 2))} caption="Nurses to relieve the constraint" />
      </section>

      {departmentRows.some((entry) => entry.load >= 85) ? (
        <div className="alert-line is-critical" role="status">
          <div className="alert-line-main">
            <span className="alert-line-title">
              {departmentRows.filter((entry) => entry.load >= 85).length} department(s) above 85% nursing workload
            </span>
            <span className="alert-line-meta">
              {departmentRows
                .filter((entry) => entry.load >= 85)
                .map((entry) => `${entry.name} ${entry.load}%`)
                .join(' · ')}
            </span>
          </div>
        </div>
      ) : null}

      <Panel title="Nurse allocation" icon={Users} subtitle={`${rows.length} nurse(s) shown · lowest assignment first · confirmations update the nurse roster`}>
        <FilterBar
          search={<SearchBar value={query} onChange={setQuery} onClear={() => setQuery('')} placeholder="Search nurse or assignment…" label="Search nurses" id="nurse-allocation-search" />}
          filters={[
            { id: 'department', label: 'Department', value: department, onChange: setDepartment, options: [{ value: 'all', label: 'All departments' }, ...departments.map((entry) => ({ value: entry, label: entry }))] },
          ]}
          activeCount={activeFilters}
          resultCount={rows.length}
          resultLabel="nurses"
          onReset={() => {
            setQuery('');
            setDepartment('all');
          }}
        />

        <div style={{ marginTop: 12 }}>
          <DataTable
            columns={[
              { key: 'name', header: 'Nurse', strong: true, render: (row) => `${row.name} · ${row.id}` },
              { key: 'department', header: 'Department' },
              { key: 'dutyStatus', header: 'Duty', render: (row) => <StatusBadge status={row.dutyStatus} size="sm" /> },
              { key: 'availability', header: 'Availability', render: (row) => <StatusBadge status={row.availability} size="sm" /> },
              {
                key: 'workload',
                header: 'Workload',
                render: (row) => (
                  <span className={row.assignedPatients >= NURSE_WORKLOAD_LIMIT ? 'text-alert' : ''}>
                    {row.assignedPatients}/{NURSE_WORKLOAD_LIMIT} {row.assignedPatients >= NURSE_WORKLOAD_LIMIT ? '· at limit' : ''}
                  </span>
                ),
              },
              {
                key: 'actions',
                header: 'Actions',
                align: 'right',
                render: (row) => {
                  const deployableNow = row.availability === 'Available' && row.dutyStatus === 'ON_DUTY';
                  return (
                    <div className="row row-tight">
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => setSelected(row)}>
                        Review
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => actions.pushActivity(`${row.name} recommended for ${row.department} reinforcement`, 'info')}
                      >
                        Recommend
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={!deployableNow}
                        title={deployableNow ? 'Confirm deployment' : 'Already assigned or off duty'}
                        onClick={() => setPending({ nurse: row, entry: targetCase })}
                      >
                        Deploy
                      </button>
                    </div>
                  );
                },
              },
            ]}
            rows={rows}
            getRowKey={(row) => row.id}
            emptyTitle="No nurses match this view"
            emptyText="Change the department filter to see other nurses."
          />
        </div>
      </Panel>

      <section className="grid-2">
        <Panel title="Workload by department" icon={Users} subtitle={`Constraint: ${NURSE_WORKLOAD_LIMIT} patients per nurse`}>
          <div className="stack">
            {departmentRows.map((entry) => (
              <UsageBar
                key={entry.id}
                label={entry.name}
                value={entry.load}
                tone={entry.load >= 90 ? 'alert' : entry.load >= 75 ? 'teal' : 'success'}
                helper={`${entry.staffed} on duty · ${entry.available} deployable · ${entry.atConstraint} at limit`}
              />
            ))}
          </div>
        </Panel>

        <Panel title="Reinforcement plan" icon={Users} subtitle="Where the next deployable nurses should go">
          <ul className="conflict-list">
            {departmentRows
              .slice()
              .sort((a, b) => b.load - a.load)
              .slice(0, 4)
              .map((entry) => (
                <li key={entry.id}>
                  <span className={`status-dot ${entry.load >= 90 ? 'is-alert' : entry.load >= 75 ? 'is-warn' : 'is-ok'}`} aria-hidden="true" />
                  <span className="conflict-list-text">
                    <span className="conflict-list-title">{entry.name}</span>
                    <span className="conflict-list-meta">
                      {entry.load}% workload · needs {Math.max(0, Math.ceil((entry.load - 75) / 20)) || 1} nurse(s) to drop below the constraint
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => actions.pushActivity(`Reinforcement recommended for ${entry.name} (${entry.load}% workload)`, 'info')}
                  >
                    Recommend
                  </button>
                </li>
              ))}
          </ul>
        </Panel>
      </section>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.name} · ${selected.id}` : ''}
        subtitle={selected ? `${selected.department} · ${selected.shift}` : ''}
        size="md"
        badge={selected ? <StatusBadge status={selected.availability} size="sm" /> : null}
      >
        {selected ? (
          <>
            <div className="stat-grid cols-3">
              <StatTile label="Assigned patients" value={`${selected.assignedPatients}/${NURSE_WORKLOAD_LIMIT}`} hint="Workload constraint" tone={selected.assignedPatients >= NURSE_WORKLOAD_LIMIT ? 'alert' : 'neutral'} />
              <StatTile label="Workload" value={selected.workload} />
              <StatTile label="Duty" value={selected.dutyStatus === 'ON_DUTY' ? 'On duty' : 'Off duty'} hint={selected.shiftBlock} />
            </div>
            <div className="kv">
              <span className="kv-key">Current assignment</span>
              <span className="kv-value">{selected.currentAssignment}</span>
            </div>
          </>
        ) : null}
      </DetailModal>

      <ConfirmationModal
        open={Boolean(pending)}
        title="Confirm nurse deployment"
        subtitle={pending ? `${pending.nurse.name} → ${pending.nurse.department}` : ''}
        confirmLabel="Confirm deployment"
        onClose={() => setPending(null)}
        onConfirm={({ reason }) => {
          actions.assignNurse(pending.entry?.id || 'queue', pending.nurse.id, pending.nurse.department);
          if (reason) actions.pushActivity(`Deployment note: ${reason}`, 'info');
          setPending(null);
        }}
        requireReason
        reasonLabel="Operational note"
        consequences={[
          `${pending?.nurse?.name} is marked assigned in the nurse roster.`,
          'Workload counters update for the department immediately.',
          'Existing patient assignments are not reassigned or cancelled.',
        ]}
        summary={
          pending ? (
            <div className="stat-grid cols-3">
              <StatTile label="Nurse" value={pending.nurse.id} hint={pending.nurse.department} />
              <StatTile label="Current load" value={`${pending.nurse.assignedPatients}/${NURSE_WORKLOAD_LIMIT}`} />
              <StatTile label="Priority case" value={pending.entry ? pending.entry.id : 'None waiting'} hint={pending.entry?.priority || ''} />
            </div>
          ) : null
        }
      />
    </div>
  );
}
