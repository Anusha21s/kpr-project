import { useNavigate } from 'react-router-dom';
import {
  BedDouble,
  CalendarClock,
  ClipboardList,
  Cpu,
  HeartPulse,
  ShieldAlert,
  Stethoscope,
} from 'lucide-react';
import KpiTile from '../../components/KpiTile';
import Panel from '../../components/Panel';
import DataTable from '../../components/DataTable';
import StatusBadge from '../../components/StatusBadge';
import QuickActionGrid from '../../components/QuickActionGrid';
import DetailModal from '../../components/DetailModal';
import WorkflowStrip from '../../components/WorkflowStrip';
import { useHospital } from '../../hooks/useHospital';
import { rankQueue } from '../../utils/optimizationEngine';
import { formatClock } from '../../utils/time';
import { useState } from 'react';

/**
 * Resource Coordinator — "What needs allocating or confirming?" (section 21).
 * Allocation workload first, then the availability of each resource class.
 */
export default function ResourceOverview() {
  const { state, metrics, actions } = useHospital();
  const navigate = useNavigate();
  const [selected, setSelected] = useState(null);

  const pendingApprovals = state.approvals.filter((approval) => approval.status === 'Pending Review');
  const openConflicts = (state.conflicts || []).filter((conflict) => conflict.status !== 'Mitigated');
  const allocationQueue = rankQueue(state.queue).filter((entry) => entry.status !== 'Allocated').slice(0, 6);

  return (
    <div className="page">
      {pendingApprovals.length ? (
        <div className="alert-line is-operational" role="status">
          <div className="alert-line-main">
            <span className="alert-line-title">{pendingApprovals.length} recommendation awaiting confirmation</span>
            <span className="alert-line-meta">
              {pendingApprovals[0].title} — nothing is applied until you confirm it.
            </span>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/resources/approvals')}>
            Review
          </button>
        </div>
      ) : (
        <div className="alert-line is-success" role="status">
          <div className="alert-line-main">
            <span className="alert-line-title">No recommendations awaiting confirmation</span>
            <span className="alert-line-meta">The command center raises recommendations when hospital pressure rises.</span>
          </div>
        </div>
      )}

      <section className="kpi-row" aria-label="Coordination workload">
        <KpiTile
          label="Pending allocations"
          icon={ClipboardList}
          tone={pendingApprovals.length ? 'alert' : 'teal'}
          value={pendingApprovals.length}
          caption={pendingApprovals.length ? 'Recommendations awaiting confirmation' : 'Nothing awaiting confirmation'}
          to="/resources/approvals"
        />
        <KpiTile
          label="Resource conflicts"
          icon={ShieldAlert}
          tone={openConflicts.length ? 'alert' : 'teal'}
          value={openConflicts.length}
          caption={openConflicts.length ? 'Require a coordination decision' : 'No open conflicts'}
          to="/resources/conflicts"
        />
        <KpiTile
          label="Awaiting placement"
          icon={ClipboardList}
          tone={allocationQueue.length ? 'blue' : 'teal'}
          value={allocationQueue.length}
          caption={`Longest wait ${metrics.queue.longestWait} min`}
          to="/resources/beds"
        />
        <KpiTile
          label="Placements recorded"
          icon={BedDouble}
          tone="teal"
          value={state.allocations.length}
          caption="Beds and units confirmed this session"
          to="/resources/approvals"
        />
      </section>

      {/* ------------------------------------ availability, one card per class */}
      <Panel title="Resource availability" icon={ClipboardList} subtitle="Open the class you need to allocate">
        <QuickActionGrid
          columns={5}
          actions={[
            {
              label: 'Beds',
              hint: `${metrics.beds.available} bed(s) available · ${metrics.beds.occupancyPercentage}% occupancy`,
              icon: BedDouble,
              to: '/resources/beds',
              tone: metrics.beds.available <= 5 ? 'alert' : 'blue',
            },
            {
              label: 'ICU',
              hint: `${metrics.beds.icu.available} vacant · ${metrics.queue.icuRequests} request(s)`,
              icon: HeartPulse,
              to: '/resources/icu',
              tone: metrics.beds.icu.available <= 1 ? 'alert' : 'blue',
            },
            {
              label: 'Theatres',
              hint: `${metrics.ot.available} free · ${state.otBacklog.length} request(s)`,
              icon: CalendarClock,
              to: '/resources/ot',
              tone: metrics.ot.available === 0 ? 'alert' : 'blue',
            },
            {
              label: 'Staff',
              hint: `${metrics.doctors.available} doctors · ${metrics.nurses.available} nurses available`,
              icon: Stethoscope,
              to: '/resources/doctors',
              tone: metrics.nurses.atConstraint || metrics.doctors.available <= 3 ? 'alert' : 'teal',
            },
            {
              label: 'Equipment',
              hint: `${metrics.equipment.availableUnits} units free · ${metrics.equipment.utilisation}% utilisation`,
              icon: Cpu,
              to: '/resources/equipment',
              tone: metrics.equipment.availableUnits <= 8 ? 'alert' : 'blue',
            },
          ]}
        />
      </Panel>

      <section className="grid-2">
        <Panel
          title="Allocation queue"
          icon={ClipboardList}
          subtitle={`${allocationQueue.length} patients awaiting placement`}
          linkTo="/resources/beds"
          linkLabel="Bed allocation"
        >
          <DataTable
            columns={[
              { key: 'id', header: 'Patient', strong: true, render: (row) => <span className="mono">{row.id}</span> },
              { key: 'priority', header: 'Priority', render: (row) => <StatusBadge status={row.priority} size="sm" /> },
              { key: 'requiredResource', header: 'Requires' },
              { key: 'waitingMinutes', header: 'Waiting', render: (row) => `${row.waitingMinutes} min` },
            ]}
            rows={allocationQueue}
            getRowKey={(row) => row.id}
            onRowClick={(row) => setSelected(row)}
            emptyTitle="Allocation queue clear"
            emptyText="Every patient with a recorded requirement has been placed."
          />
        </Panel>

        <Panel
          title="Open conflicts"
          icon={ShieldAlert}
          subtitle={`${openConflicts.length} detected across resources`}
          linkTo="/resources/conflicts"
          linkLabel="Conflict centre"
        >
          {openConflicts.length ? (
            <ul className="conflict-list">
              {openConflicts.slice(0, 4).map((conflict) => (
                <li key={conflict.id}>
                  <span className={`status-dot ${conflict.severity === 'Critical' ? 'is-alert' : 'is-info'}`} aria-hidden="true" />
                  <span className="conflict-list-text">
                    <span className="conflict-list-title">{conflict.title}</span>
                    <span className="conflict-list-meta">
                      {conflict.summary} · {conflict.resource || conflict.requirement}
                    </span>
                  </span>
                  <StatusBadge status={conflict.severity} size="sm" />
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-line">No open conflicts</p>
          )}
        </Panel>
      </section>

      <WorkflowStrip stage={state.surge.processed ? 'confirmed' : pendingApprovals.length ? 'recommendation' : openConflicts.length ? 'analysis' : 'visibility'} />

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `Patient ${selected.id}` : ''}
        subtitle={selected ? `${selected.priority} priority · waiting ${selected.waitingMinutes} min` : ''}
        badge={
          selected ? (
            <>
              <StatusBadge status={selected.priority} size="sm" />
              <span className="badge badge-neutral text-xs">{selected.requiredResource}</span>
            </>
          ) : null
        }
        footer={
          selected ? (
            <>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => {
                  actions.recordRequirement?.(selected.id, 'Reviewed by the resource coordinator');
                  setSelected(null);
                }}
              >
                Review
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setSelected(null);
                  if (selected.requiredResource === 'ICU Bed') navigate('/resources/icu');
                  else navigate('/resources/beds');
                }}
              >
                Open allocation
              </button>
            </>
          ) : null
        }
      >
        {selected ? (
          <>
            <div className="kv">
              <span className="kv-key">Requirement recorded by</span>
              <span className="kv-value">{selected.clinicalRequirementBy || 'Clinical team'}</span>
            </div>
            {selected.requirementConfirmedAt ? (
              <div className="kv">
                <span className="kv-key">Recorded at</span>
                <span className="kv-value">{formatClock(new Date(selected.requirementConfirmedAt))}</span>
              </div>
            ) : null}
            <div className="kv">
              <span className="kv-key">Specialty required</span>
              <span className="kv-value">{selected.specialtyRequired}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Ventilator</span>
              <span className="kv-value">{selected.requiresVentilator ? 'Required' : 'Not required'}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Status</span>
              <span className="kv-value">{selected.status}</span>
            </div>
            {selected.notes ? <p className="text-small text-secondary">{selected.notes}</p> : null}
          </>
        ) : null}
      </DetailModal>
    </div>
  );
}
