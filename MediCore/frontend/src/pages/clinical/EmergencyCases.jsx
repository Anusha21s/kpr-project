import { useMemo, useState } from 'react';
import { Siren } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import DataTable from '../../components/DataTable';
import StatusBadge from '../../components/StatusBadge';
import FilterBar from '../../components/FilterBar';
import DetailModal from '../../components/DetailModal';
import StatTile from '../../components/StatTile';
import { useHospital } from '../../hooks/useHospital';
import { useAuth } from '../../hooks/useAuth';
import { rankQueue } from '../../utils/optimizationEngine';
import { formatClock } from '../../utils/time';

/**
 * Emergency Cases (clinical) — the clinical view of the queue.
 * Doctors record the requirement; nurses see monitoring needs. Neither role
 * allocates hospital resources here.
 */
export default function EmergencyCases() {
  const { state, actions } = useHospital();
  const { user } = useAuth();
  const [priority, setPriority] = useState('Critical');
  const [specialty, setSpecialty] = useState('all');
  const [selected, setSelected] = useState(null);

  const isDoctor = user.role === 'doctor';
  const specialties = useMemo(() => Array.from(new Set(state.queue.map((entry) => entry.specialtyRequired))).sort(), [state.queue]);

  const rows = useMemo(() => {
    const ranked = rankQueue(state.queue);
    const filtered = ranked.filter((entry) => {
      const matchesPriority = priority === 'all' || entry.priority === priority;
      const matchesSpecialty = specialty === 'all' || entry.specialtyRequired === specialty;
      return matchesPriority && matchesSpecialty;
    });
    return isDoctor ? filtered : filtered.filter((entry) => entry.priority === 'Critical' || entry.priority === 'High');
  }, [state.queue, priority, specialty, isDoctor]);

  return (
    <div className="page">
      <section className="kpi-row" aria-label="Emergency cases">
        <KpiTile label="Critical" icon={Siren} tone="alert" value={state.queue.filter((entry) => entry.priority === 'Critical').length} caption="Require immediate placement" />
        <KpiTile label="High priority" icon={Siren} value={state.queue.filter((entry) => entry.priority === 'High').length} caption="Awaiting a resource" />
        <KpiTile label="ICU-level" icon={Siren} tone="alert" value={state.queue.filter((entry) => entry.requiredResource === 'ICU Bed').length} caption="Requiring critical-care beds" />
        <KpiTile label="Ventilation" icon={Siren} tone="alert" value={state.queue.filter((entry) => entry.requiresVentilator).length} caption="Requiring ventilator support" />
        <KpiTile label="Longest wait" icon={Siren} tone="teal" value={state.queue.reduce((max, entry) => Math.max(max, entry.waitingMinutes), 0)} suffix=" min" caption="In the emergency queue" />
        <KpiTile label="Recorded" icon={Siren} value={state.queue.filter((entry) => entry.clinicalRequirementBy).length} caption="Requirement confirmed by clinical staff" />
      </section>

      <Panel
        title="Emergency cases"
        icon={Siren}
        subtitle={
          isDoctor
            ? `${rows.length} case(s) shown · confirm the resource requirement so coordination can plan`
            : `${rows.length} high-acuity case(s) · monitoring requirement only`
        }
        actions={
          <span className="badge badge-neutral text-xs">
            Updated {formatClock(new Date())}
          </span>
        }
      >
        <FilterBar
          filters={[
            {
              id: 'priority',
              label: 'Priority',
              value: priority,
              onChange: setPriority,
              options: [
                { value: 'Critical', label: 'Critical' },
                { value: 'High', label: 'High' },
                { value: 'all', label: 'All priorities' },
              ],
            },
            { id: 'specialty', label: 'Specialty', value: specialty, onChange: setSpecialty, options: [{ value: 'all', label: 'All specialties' }, ...specialties.map((entry) => ({ value: entry, label: entry }))] },
          ]}
          activeCount={(priority !== 'Critical' ? 1 : 0) + (specialty !== 'all' ? 1 : 0)}
          resultCount={rows.length}
          resultLabel="cases"
          onReset={() => {
            setPriority('Critical');
            setSpecialty('all');
          }}
        />

        <div style={{ marginTop: 12 }}>
          <DataTable
            columns={[
              { key: 'id', header: 'Patient', strong: true, render: (row) => <span className="mono">{row.id}</span> },
              { key: 'priority', header: 'Priority', render: (row) => <StatusBadge status={row.priority} size="sm" /> },
              { key: 'requiredResource', header: 'Required unit' },
              { key: 'specialtyRequired', header: 'Specialty' },
              { key: 'waitingMinutes', header: 'Waiting', render: (row) => `${row.waitingMinutes} min` },
              {
                key: 'status',
                header: 'Status',
                render: (row) => <StatusBadge status={row.status} size="sm" />,
              },
            ]}
            rows={rows}
            getRowKey={(row) => row.id}
            onRowClick={(row) => setSelected(row)}
            emptyTitle="No cases match this view"
            emptyText="Change the filters to see other cases."
          />
        </div>
      </Panel>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `Patient ${selected.id}` : ''}
        subtitle={selected ? `${selected.age}y ${selected.sex} · ${selected.triage} · ${selected.department}` : ''}
        size="md"
        badge={selected ? <><StatusBadge status={selected.priority} size="sm" /><StatusBadge status={selected.status} size="sm" /></> : null}
        footer={
          selected ? (
            isDoctor ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  actions.recordRequirement(selected.id, 'Requirement confirmed from the clinical dashboard');
                  setSelected(null);
                }}
              >
                Confirm requirement
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => {
                  actions.pushActivity(`Monitoring noted for ${selected.id}`, 'info');
                  setSelected(null);
                }}
              >
                Note monitoring
              </button>
            )
          ) : null
        }
      >
        {selected ? (
          <>
            <div className="stat-grid cols-3">
              <StatTile label="Requires" value={selected.requiredResource} hint={selected.secondaryResource ? `then ${selected.secondaryResource}` : 'Primary requirement'} />
              <StatTile label="Ventilator" value={selected.requiresVentilator ? 'Required' : 'Not required'} tone={selected.requiresVentilator ? 'alert' : 'neutral'} />
              <StatTile label="Waiting" value={`${selected.waitingMinutes} min`} hint="Since triage" />
            </div>
            <div className="kv">
              <span className="kv-key">Requirement recorded by</span>
              <span className="kv-value">{selected.clinicalRequirementBy || 'Awaiting review'}</span>
            </div>
            {selected.notes ? <p className="text-small text-secondary">{selected.notes}</p> : null}
            <p className="text-xs text-secondary">
              Resource availability does not block emergency treatment. MediCore coordinates placement; clinical decisions remain with
              the treating team.
            </p>
          </>
        ) : null}
      </DetailModal>
    </div>
  );
}
