import { useState } from 'react';
import { HeartPulse } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import DataTable from '../../components/DataTable';
import StatusBadge from '../../components/StatusBadge';
import ConfirmationModal from '../../components/ConfirmationModal';
import DetailModal from '../../components/DetailModal';
import StatTile from '../../components/StatTile';
import UsageBar from '../../components/UsageBar';
import { useHospital } from '../../hooks/useHospital';
import { ESCALATION_BEDS } from '../../data/beds';

/**
 * ICU Allocation (section 21) — the capacity gap and the two operational
 * options. Capacity is escalated by the coordinator; clinical eligibility for
 * ICU care is never decided here.
 */
export default function IcuAllocation() {
  const { state, metrics, actions } = useHospital();
  const [option, setOption] = useState('icu-option-a');
  const [pending, setPending] = useState(null);
  const [selected, setSelected] = useState(null);

  const icuRequests = state.queue.filter((entry) => entry.requiredResource === 'ICU Bed' || entry.secondaryResource === 'ICU Bed');
  const icuWard = metrics.beds.icu;
  const gap = Math.max(0, icuRequests.length - icuWard.available);
  const icuBeds = state.bedUnits.filter((unit) => unit.wardId === 'icu');
  const vacated = metrics.beds.icu.available;

  const options = [
    {
      id: 'icu-option-a',
      label: `${ESCALATION_BEDS.length} critical-care step-down bays`,
      detail: `Activate ${ESCALATION_BEDS.map((bed) => bed.id).join(' and ')} with ICU governance and cardiac monitoring.`,
      addedCapacity: ESCALATION_BEDS.length,
      tradeoff: 'Requires 2 ventilators and 4 nurses from the surge pool.',
      recommended: true,
    },
    {
      id: 'icu-option-b',
      label: 'Escalation / transfer review',
      detail: 'Open a transfer review for the most clinically stable ICU case with the treating team.',
      addedCapacity: 1,
      tradeoff: 'Capacity available only after clinical clearance and ambulance confirmation.',
      recommended: false,
    },
  ];

  const confirmOption = ({ reason }) => {
    if (option === 'icu-option-a') {
      actions.pushActivity(`ICU escalation confirmed — ${ESCALATION_BEDS.length} step-down bays activated (${ESCALATION_BEDS.map((bed) => bed.id).join(', ')})`, 'success');
      if (icuRequests[0]) actions.confirmBedAllocation(ESCALATION_BEDS[0].id, icuRequests[0].id, 'ICU Bed (escalation)');
    } else {
      actions.pushActivity('Escalation / transfer review requested — clinical clearance required', 'alert');
    }
    if (reason) actions.pushActivity(`Escalation note: ${reason}`, 'info');
    setPending(null);
  };

  return (
    <div className="page">
      <section className="kpi-row" aria-label="ICU capacity">
        <KpiTile label="ICU capacity" icon={HeartPulse} value={icuWard.units} caption={`${icuWard.baseUnits || 10} configured${icuWard.escalation ? ` + ${icuWard.escalation} escalation` : ''}`} />
        <KpiTile label="Committed" icon={HeartPulse} value={icuWard.committed} caption={`${icuWard.reserved} held · ${icuWard.available} vacant`} progress={icuWard.occupancyPercentage} />
        <KpiTile label="ICU requests" icon={HeartPulse} tone={icuRequests.length ? 'alert' : 'teal'} value={icuRequests.length} caption={`${icuRequests.filter((entry) => entry.priority === 'Critical').length} critical`} />
        <KpiTile label="Capacity gap" icon={HeartPulse} tone={gap ? 'alert' : 'teal'} value={gap} caption={gap ? 'Requests beyond current vacancy' : 'No gap'} />
        <KpiTile label="Vacant beds" icon={HeartPulse} tone={vacated <= 1 ? 'alert' : 'teal'} value={vacated} caption="Ready for allocation" />
        <KpiTile label="Pressure index" icon={HeartPulse} tone={metrics.pressure.byId.icu.pressure >= 85 ? 'alert' : 'blue'} value={metrics.pressure.byId.icu.pressure} caption={metrics.pressure.byId.icu.detail} progress={metrics.pressure.byId.icu.pressure} />
      </section>

      <section className="grid-2">
        <Panel
          title="Operational options for the gap"
          icon={HeartPulse}
          subtitle={gap ? `${gap} ICU-level request(s) beyond current vacancy` : 'No escalation required'}
        >
          <div className="stack">
            {options.map((entry) => (
              <label key={entry.id} className={`option-card ${option === entry.id ? 'is-selected' : ''}`}>
                <div className="row-between">
                  <span className="text-medium">{entry.label}</span>
                  <input type="radio" name="icu-option" checked={option === entry.id} onChange={() => setOption(entry.id)} style={{ accentColor: 'var(--primary-blue)' }} />
                </div>
                <p className="text-small text-secondary">{entry.detail}</p>
                <div className="row row-tight">
                  <span className="badge badge-info text-xs">+{entry.addedCapacity} capacity</span>
                  {entry.recommended ? <span className="badge badge-success text-xs">Engine recommended</span> : null}
                  {entry.id === 'icu-option-b' ? <span className="badge badge-medium text-xs">Clinical clearance required</span> : null}
                </div>
                <p className="text-xs text-secondary">Trade-off: {entry.tradeoff}</p>
              </label>
            ))}
          </div>
          <div className="row row-tight" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-primary" onClick={() => setPending(options.find((entry) => entry.id === option))}>
              Confirm escalation option
            </button>
            <button type="button" className="btn btn-outline" onClick={() => actions.pushActivity('ICU escalation deferred — monitoring every 15 minutes', 'info')}>
              Defer and monitor
            </button>
          </div>
        </Panel>

        <div className="stack-lg">
          <Panel title="ICU beds" icon={HeartPulse} subtitle={`${icuBeds.length} beds · allocate a vacant bed directly`}>
            <DataTable
              columns={[
                { key: 'id', header: 'Bed', strong: true, render: (row) => <span className="mono">{row.id}</span> },
                { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} size="sm" /> },
                { key: 'heldFor', header: 'Held for', render: (row) => row.heldFor || '—' },
              ]}
              rows={icuBeds}
              getRowKey={(row) => row.id}
              onRowClick={(row) => setSelected(row)}
              compact
            />
          </Panel>

          <Panel title="Ventilator dependency" icon={HeartPulse} subtitle="Step-down bays require ventilator cover">
            <UsageBar label="Ventilator utilisation" value={metrics.equipment.ventilators.utilisation} tone={metrics.equipment.ventilators.utilisation >= 80 ? 'alert' : 'teal'} />
            <div className="stat-grid cols-3" style={{ marginTop: 12 }}>
              <StatTile label="Available" value={metrics.equipment.ventilators.available} hint="Free units" tone={metrics.equipment.ventilators.available <= 3 ? 'alert' : 'neutral'} />
              <StatTile label="Reserved" value={metrics.equipment.ventilators.reserved} hint="Held for cases" />
              <StatTile label="Required" value={metrics.queue.ventilatorRequests} hint="Queued patients" />
            </div>
          </Panel>
        </div>
      </section>

      <Panel title="Pending ICU requests" icon={HeartPulse} subtitle="Requirement recorded by the clinical team, in priority order">
        <DataTable
          columns={[
            { key: 'id', header: 'Patient', strong: true, render: (row) => <span className="mono">{row.id}</span> },
            { key: 'priority', header: 'Priority', render: (row) => <StatusBadge status={row.priority} size="sm" /> },
            { key: 'requiredResource', header: 'Requirement', render: (row) => `${row.requiredResource}${row.requiresVentilator ? ' + ventilator' : ''}` },
            { key: 'specialtyRequired', header: 'Specialty' },
            { key: 'waitingMinutes', header: 'Waiting', render: (row) => `${row.waitingMinutes} min` },
            { key: 'clinicalRequirementBy', header: 'Recorded by' },
            {
              key: 'position',
              header: 'Position',
              render: (row) =>
                row.id === icuRequests[0]?.id && vacated > 0 ? (
                  <StatusBadge status="Available" label="Next for vacancy" size="sm" />
                ) : (
                  <StatusBadge status="Pending Review" label="Awaiting capacity" size="sm" />
                ),
            },
          ]}
          rows={icuRequests}
          getRowKey={(row) => row.id}
          emptyTitle="No ICU requests pending"
          emptyText="No patient currently has an ICU-level requirement recorded."
        />
      </Panel>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `Bed ${selected.id}` : ''}
        subtitle={selected ? `${selected.ward} · ${selected.bedType}` : ''}
        badge={selected ? <StatusBadge status={selected.status} size="sm" /> : null}
        footer={
          selected && selected.status === 'Available' && icuRequests[0] ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setPending({ id: 'direct', label: `Allocate ${selected.id}`, detail: `Allocate ${selected.id} to ${icuRequests[0].id}.` });
              }}
            >
              Allocate to {icuRequests[0].id}
            </button>
          ) : null
        }
      >
        {selected ? (
          <div className="stat-grid cols-2">
            <StatTile label="Patient" value={selected.patient || 'Unoccupied'} />
            <StatTile label="Held for" value={selected.heldFor || '—'} hint="Provisional hold" />
          </div>
        ) : null}
      </DetailModal>

      <ConfirmationModal
        open={Boolean(pending)}
        title="Confirm ICU escalation"
        subtitle={pending?.label}
        confirmLabel="Confirm option"
        onClose={() => setPending(null)}
        onConfirm={confirmOption}
        requireReason
        reasonLabel="Operational note"
        consequences={
          option === 'icu-option-a'
            ? [
                `${ESCALATION_BEDS.length} step-down bays become ICU-governed capacity with cardiac monitoring.`,
                'Two ventilators are linked and 4 nurses are requested from the surge pool.',
                'No existing patient is moved or discharged.',
              ]
            : [
                'A transfer-review request is opened for the most clinically stable ICU case.',
                'Capacity becomes available only after clinical clearance and ambulance confirmation.',
                'MediCore does not move or transfer any patient.',
              ]
        }
        summary={pending ? <p className="text-small text-secondary">{pending.detail}</p> : null}
      />
    </div>
  );
}
