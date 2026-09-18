import { useMemo, useState } from 'react';
import { ClipboardCheck, ShieldCheck, Undo2 } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import DataTable from '../../components/DataTable';
import StatusBadge from '../../components/StatusBadge';
import ConfirmationModal from '../../components/ConfirmationModal';
import DetailModal from '../../components/DetailModal';
import StatTile from '../../components/StatTile';
import EmptyState from '../../components/EmptyState';
import { useHospital } from '../../hooks/useHospital';
import { optimizeResources } from '../../utils/optimizationEngine';

const ACTION_LABEL = {
  'REC-ICU-01': 'Review options then escalate capacity',
  'REC-BED-01': 'Confirm 8 general beds',
  'REC-DOC-01': 'Confirm doctor assignment',
  'REC-NUR-01': 'Deploy nurses',
  'REC-EQP-01': 'Allocate ventilators',
  'REC-OT-01': 'Hold theatre slot',
  'REC-EMG-01': 'Reinforce emergency bays',
};

/**
 * Pending Approvals — the coordinator's review surface.
 * MediCore raises an approval request; a person confirms or rejects it, and
 * every confirmation is recorded in the allocation trail.
 */
export default function PendingApprovals() {
  const { state, actions } = useHospital();
  const [selections, setSelections] = useState({ 'REC-ICU-01': 'icu-option-a' });
  const [pending, setPending] = useState(null);
  const [selected, setSelected] = useState(null);

  const approvals = state.approvals;
  const approval = approvals.find((entry) => entry.status === 'Pending Review') || approvals[0];
  const decided = approvals.filter((entry) => entry.status !== 'Pending Review');

  const analysis = useMemo(() => analyseOptimization(state, selections), [state, selections]);
  const recommendations = state.optimization?.recommendations || [];
  const rejected = state.rejectedRecommendations || [];
  const openRecommendations = recommendations.filter((entry) => !rejected.some((item) => item.id === entry.id));

  return (
    <div className="page">
      <section className="kpi-row" aria-label="Approval status">
        <KpiTile label="Pending review" icon={ClipboardCheck} tone={approval && approval.status === 'Pending Review' ? 'alert' : 'teal'} value={approvals.filter((entry) => entry.status === 'Pending Review').length} caption="Awaiting coordinator decision" />
        <KpiTile label="Recommendations" icon={ClipboardCheck} value={openRecommendations.length} caption={`${rejected.length} rejected`} />
        <KpiTile label="Resources covered" icon={ClipboardCheck} value={recommendations.length} caption="Beds, ICU, doctors, nurses, equipment, OT" />
        <KpiTile label="Conflicts raised" icon={ClipboardCheck} tone={state.optimization?.conflicts?.length ? 'alert' : 'teal'} value={state.optimization?.conflicts?.length || state.conflicts.length} caption="Detected with the request" />
        <KpiTile label="Decided" icon={ShieldCheck} tone="teal" value={decided.length} caption="Confirmed or rejected this session" />
        <KpiTile label="Placements" icon={ShieldCheck} value={state.allocations.length} caption="Recorded allocation trail" />
      </section>

      {!approval ? (
        <Panel title="No allocation awaiting review" icon={ClipboardCheck} subtitle="Requests raised by the command center appear here">
          <EmptyState
            icon={ClipboardCheck}
            title="Nothing pending"
            text="The command center has not raised an allocation request yet. When the emergency queue grows, the optimisation run creates a request for review."
          />
        </Panel>
      ) : (
        <Panel
          title={`Approval ${approval.id}`}
          icon={ClipboardCheck}
          subtitle={`${approval.title} · requested by ${approval.requestedBy}`}
          actions={<StatusBadge status={approval.status} size="sm" />}
        >
          <div className="stat-grid cols-4">
            <StatTile label="Raised" value={new Date(approval.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} hint={approval.priority} />
            <StatTile label="General beds" value={approval.summary.generalBeds ?? 0} hint="Proposed change" />
            <StatTile label="Ventilators" value={approval.summary.ventilators ?? 0} hint="Proposed allocation" />
            <StatTile label="Nurses" value={approval.summary.nurses ?? 0} hint={`${approval.summary.doctors ?? 0} doctors`} />
          </div>

          <DataTable
            columns={[
              { key: 'id', header: 'Ref', strong: true, render: (row) => <span className="mono">{row.id}</span> },
              { key: 'resource', header: 'Resource' },
              { key: 'title', header: 'Proposed action' },
              { key: 'highlight', header: 'Change' },
              {
                key: 'state',
                header: 'Review state',
                render: (row) =>
                  rejected.some((entry) => entry.id === row.id) ? (
                    <StatusBadge status="Rejected" size="sm" />
                  ) : row.requiresApproval ? (
                    <StatusBadge status="Pending Review" label="Review required" size="sm" />
                  ) : (
                    <StatusBadge status="Available" label="Informational" size="sm" />
                  ),
              },
              {
                key: 'actions',
                header: 'Actions',
                align: 'right',
                render: (row) => (
                  <div className="row row-tight">
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => setSelected({ recommendation: row, options: analysis?.recommendations?.find((entry) => entry.id === row.id)?.options || [] })}
                    >
                      Review
                    </button>
                    {row.id === 'REC-ICU-01' ? (
                      <select
                        className="input"
                        style={{ maxWidth: 190, height: 'auto', padding: '4px 8px', fontSize: 12 }}
                        aria-label="ICU escalation option"
                        value={selections['REC-ICU-01']}
                        onChange={(event) => setSelections({ 'REC-ICU-01': event.target.value })}
                      >
                        <option value="icu-option-a">2 step-down bays</option>
                        <option value="icu-option-b">Transfer review</option>
                      </select>
                    ) : null}
                    {rejected.some((entry) => entry.id === row.id) ? (
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => actions.reraiseRecommendation(row.id)}>
                        <Undo2 size={12} aria-hidden="true" />
                        Re-raise
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setPending({ mode: 'reject', recommendation: row })}
                      >
                        Reject
                      </button>
                    )}
                  </div>
                ),
              },
            ]}
            rows={recommendations}
            getRowKey={(row) => row.id}
            emptyTitle="No recommendation set stored"
            emptyText="Run the optimisation analysis from the command center to raise a recommendation set."
          />

          <div className="row row-tight" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={approval.status !== 'Pending Review'}
              onClick={() => setPending({ mode: 'approve' })}
            >
              <ShieldCheck size={14} aria-hidden="true" />
              {approval.status === 'Pending Review' ? 'CONFIRM ALLOCATION' : 'Allocation confirmed'}
            </button>
            <button
              type="button"
              className="btn btn-outline"
              disabled={approval.status !== 'Pending Review'}
              onClick={() => setPending({ mode: 'reject' })}
            >
              Reject request
            </button>
            <span className="text-xs text-secondary">
              Nothing is applied automatically. {openRecommendations.filter((entry) => entry.requiresApproval).length} recommendation(s) need an
              explicit decision.
            </span>
          </div>
        </Panel>
      )}

      <section className="grid-2">
        <Panel title="Projected impact" icon={ClipboardCheck} subtitle="What the confirmation changes">
          <DataTable
            columns={[
              { key: 'label', header: 'Metric', strong: true },
              { key: 'before', header: 'Before' },
              { key: 'after', header: 'After' },
              { key: 'delta', header: 'Change', render: (row) => (row.delta > 0 ? `+${row.delta} ${row.unit}` : `${row.delta} ${row.unit}`) },
            ]}
            rows={(state.optimization?.impact || analysis?.impact || []).map((row) => ({ ...row, delta: Number(row.after) - Number(row.before) }))}
            getRowKey={(row) => row.label}
            emptyTitle="No impact projection"
            emptyText="An optimisation run produces the before/after projection."
            compact
          />
        </Panel>

        <Panel title="Rejected recommendations" icon={Undo2} subtitle="Rejections stay visible with their reason">
          <ul className="conflict-list">
            {rejected.length ? (
              rejected.map((entry) => (
                <li key={entry.id}>
                  <span className="status-dot is-alert" aria-hidden="true" />
                  <span className="conflict-list-text">
                    <span className="conflict-list-title">
                      {entry.id} · {ACTION_LABEL[entry.id] || 'Recommendation'}
                    </span>
                    <span className="conflict-list-meta">
                      {entry.reason} · by {entry.by}
                    </span>
                  </span>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => actions.reraiseRecommendation(entry.id)}>
                    Re-raise
                  </button>
                </li>
              ))
            ) : (
              <li>
                <span className="status-dot is-ok" aria-hidden="true" />
                <span className="conflict-list-text">
                  <span className="conflict-list-title">No recommendations rejected</span>
                  <span className="conflict-list-meta">Every raised recommendation is still open for review.</span>
                </span>
              </li>
            )}
          </ul>
        </Panel>
      </section>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.recommendation.id} · ${selected.recommendation.resource}` : ''}
        subtitle={selected?.recommendation?.title}
        size="md"
        badge={selected?.recommendation?.requiresApproval ? <StatusBadge status="Pending Review" label="Review required" size="sm" /> : null}
        footer={
          selected?.recommendation?.requiresApproval ? (
            <button type="button" className="btn btn-primary" onClick={() => { setPending({ mode: 'approve' }); setSelected(null); }}>
              Include in confirmation
            </button>
          ) : null
        }
      >
        {selected ? (
          <>
            <div className="stat-grid cols-2">
              <StatTile label="Change" value={selected.recommendation.highlight} hint={selected.recommendation.summary} />
              <StatTile label="Decision" value={selected.recommendation.requiresApproval ? 'Coordinator confirmation' : 'Informational'} />
            </div>
            {selected.options.length ? (
              <Panel title="Escalation options" icon={ClipboardCheck} compact>
                <ul className="rationale-list">
                  {selected.options.map((option) => (
                    <li key={option.id || option.label}>
                      <span className="text-medium">{option.label}</span>
                      {option.detail ? <span className="text-small text-secondary"> — {option.detail}</span> : null}
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}
          </>
        ) : null}
      </DetailModal>

      <ConfirmationModal
        open={Boolean(pending)}
        title={pending?.mode === 'reject' ? 'Reject this review request' : 'Confirm allocation'}
        subtitle={
          pending?.mode === 'reject'
            ? pending.recommendation
              ? `${pending.recommendation.id} · ${pending.recommendation.resource}`
              : 'Reject the full request'
            : approval
              ? `${approval.id} · ${openRecommendations.length} recommendation(s)`
              : ''
        }
        tone={pending?.mode === 'reject' ? 'warning' : 'primary'}
        confirmLabel={pending?.mode === 'reject' ? 'Reject request' : 'CONFIRM ALLOCATION'}
        requireReason={pending?.mode === 'reject'}
        reasonLabel="Reason for rejection"
        reasonPlaceholder="Record why this cannot be applied — alternative escalation required"
        onClose={() => setPending(null)}
        onConfirm={({ reason }) => {
          if (pending.mode === 'reject') {
            if (pending.recommendation) {
              actions.rejectRecommendation(pending.recommendation.id, reason);
            } else {
              actions.rejectAllocation(approval.id, reason || 'Rejected by the resource coordinator');
            }
          } else {
            actions.confirmAllocation(approval.id, selections);
          }
          setPending(null);
        }}
        consequences={
          pending?.mode === 'reject'
            ? [
                'The recommendation stays open in the review trail with the recorded reason.',
                'No beds, staff or equipment change as a result of this decision.',
                'The command center sees the rejection and can escalate differently.',
              ]
            : [
                `${openRecommendations.length} recommendation(s) are applied to beds, staffing and equipment.`,
                'The allocation trail records who confirmed it and when.',
                'Clinical decisions and existing treatment plans are untouched.',
              ]
        }
        summary={
          pending?.mode === 'approve' && approval ? (
            <div className="stat-grid cols-3">
              <StatTile label="Request" value={approval.id} hint={approval.requestedBy} />
              <StatTile label="General beds" value={approval.summary.generalBeds ?? 0} />
              <StatTile label="Nurses" value={approval.summary.nurses ?? 0} hint={`${approval.summary.doctors ?? 0} doctors`} />
            </div>
          ) : null
        }
      />

    </div>
  );
}

/* Keep a deterministic analysis available for option detail without mutating state. */
function analyseOptimization(state, selections) {
  if (!state.optimization) return null;
  try {
    return optimizeResources(state, { selections });
  } catch (error) {
    return null;
  }
}
