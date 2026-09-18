import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BedDouble,
  CheckCircle2,
  ClipboardList,
  HeartPulse,
  Package,
  ShieldAlert,
  SlidersHorizontal,
  TriangleAlert,
  Undo2,
  Users,
  XCircle,
  Zap,
} from 'lucide-react';
import Panel from '../../components/Panel';
import StatusBadge from '../../components/StatusBadge';
import DataTable from '../../components/DataTable';
import DemoRoleSwitcher from '../../components/DemoRoleSwitcher';
import DetailModal from '../../components/DetailModal';
import ConfirmationModal from '../../components/ConfirmationModal';
import { useHospital } from '../../hooks/useHospital';
import { optimizeResources } from '../../utils/optimizationEngine';

/**
 * Resource Optimization (section 20).
 *
 * Answers one question: what should be reviewed or reallocated given the current
 * hospital situation? Current situation → constraints → recommendations →
 * projected impact, with Review / Approve / Reject on every recommendation.
 */
export default function ResourceOptimization() {
  const { state, metrics, actions, user } = useHospital();
  const [running, setRunning] = useState(false);
  const [selections, setSelections] = useState({ 'REC-ICU-01': 'icu-option-a' });
  const [reviewing, setReviewing] = useState(null);
  const [approvingId, setApprovingId] = useState(null);
  const [rejectModal, setRejectModal] = useState(null);
  const [conflictError, setConflictError] = useState('');

  const isAuthorized = user?.role === 'command_center' || user?.role === 'resource_coordinator';

  const analysis = useMemo(
    () => optimizeResources(state, { selections }),
    [state, selections],
  );

  const stored = state.optimization;
  const pendingApproval = state.approvals.find((approval) => approval.status === 'Pending Review');
  const rejected = state.rejectedRecommendations || [];
  const rejectedIds = rejected.map((entry) => entry.id);

  const approvedIds = useMemo(() => {
    const list = [];
    if (stored?.confirmed) list.push(...(stored.recommendations || []).map((r) => r.id));
    (state.approvals || []).forEach((a) => {
      if (a.status === 'Confirmed' || a.status === 'Approved') {
        if (a.recommendationId) list.push(a.recommendationId);
        if (a.id) list.push(a.id);
      }
    });
    (state.allocations || []).forEach((al) => {
      if (al.recommendationId) list.push(al.recommendationId);
      if (al.recommendationRef) list.push(al.recommendationRef);
    });
    return list;
  }, [stored, state.approvals, state.allocations]);

  const constraints = [
    {
      id: 'icu',
      label: 'ICU capacity',
      value: `${metrics.beds.icu.available} vacant of ${metrics.beds.icu.units}`,
      severity: metrics.beds.icu.available <= 1 ? 'Critical' : metrics.beds.icu.available <= 3 ? 'High' : 'Medium',
      icon: HeartPulse,
    },
    {
      id: 'nurses',
      label: 'Nurse availability',
      value: `${metrics.nurses.available} available · ${metrics.nurses.atConstraint} at workload limit`,
      severity: metrics.nurses.atConstraint >= 3 ? 'Critical' : metrics.nurses.atConstraint ? 'High' : 'Medium',
      icon: Users,
    },
    {
      id: 'queue',
      label: 'Emergency queue',
      value: `${metrics.queue.total} waiting · ${metrics.queue.critical} critical`,
      severity: metrics.queue.critical >= 6 ? 'Critical' : metrics.queue.critical >= 3 ? 'High' : 'Low',
      icon: Zap,
    },
    {
      id: 'beds',
      label: 'General beds',
      value: `${metrics.beds.general.available} available of ${metrics.beds.general.total}`,
      severity: metrics.beds.general.available <= 5 ? 'High' : 'Low',
      icon: BedDouble,
    },
    {
      id: 'ot',
      label: 'Theatre capacity',
      value: `${metrics.ot.available} free · ${state.otBacklog.length} requests pending`,
      severity: metrics.ot.available === 0 ? 'Critical' : metrics.ot.available <= 1 ? 'High' : 'Low',
      icon: ClipboardList,
    },
    {
      id: 'equipment',
      label: 'Ventilators',
      value: `${metrics.equipment.ventilators.available} available · ${metrics.queue.ventilatorRequests} required`,
      severity: metrics.equipment.ventilators.available <= 2 ? 'Critical' : metrics.equipment.ventilators.available <= 5 ? 'High' : 'Low',
      icon: Package,
    },
  ];

  const runAnalysis = async () => {
    setRunning(true);
    setConflictError('');
    try {
      await actions.optimize(selections, true);
    } finally {
      setRunning(false);
    }
  };

  const handleApprove = async (recommendation) => {
    if (!recommendation) return;
    setApprovingId(recommendation.id);
    setConflictError('');
    try {
      await actions.approveRecommendation(recommendation.id, selections);
    } catch (err) {
      setConflictError(err?.message || 'Capacity conflict detected. Run optimization again to recalculate recommendations.');
    } finally {
      setApprovingId(null);
    }
  };

  const recommendationActions = (recommendation) => {
    const isRej = rejectedIds.includes(recommendation.id);
    const isApp = approvedIds.includes(recommendation.id);

    if (isRej) {
      return (
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => actions.reraiseRecommendation(recommendation.id)}
        >
          <Undo2 size={12} aria-hidden="true" />
          Re-raise
        </button>
      );
    }

    if (isApp) {
      return (
        <div className="row row-tight">
          <StatusBadge status="Confirmed" label="Applied" size="sm" />
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setReviewing(recommendation)}>
            Review
          </button>
        </div>
      );
    }

    return (
      <div className="row row-tight">
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setReviewing(recommendation)}>
          Review
        </button>
        {isAuthorized ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={approvingId === recommendation.id}
              onClick={() => handleApprove(recommendation)}
            >
              <CheckCircle2 size={12} aria-hidden="true" />
              {approvingId === recommendation.id ? 'Applying…' : 'Approve'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setRejectModal(recommendation)}
            >
              Reject
            </button>
          </>
        ) : null}
      </div>
    );
  };

  return (
    <div className="page">
      {/* ------------------------------------------------------- current situation */}
      <section className="surge-stage is-slim">
        <div className="surge-stage-status">
          <SlidersHorizontal size={16} className="text-secondary" aria-hidden="true" />
          <div>
            <p className="surge-stage-label">Current situation</p>
            <p className="surge-stage-value">{state.surge.active ? 'Emergency surge detected' : 'Baseline operations'}</p>
          </div>
        </div>
        <div className="surge-stage-status">
          <TriangleAlert size={16} className={metrics.pressure.overall >= 80 ? 'text-alert' : 'text-secondary'} aria-hidden="true" />
          <div>
            <p className="surge-stage-label">Resource pressure</p>
            <p className="surge-stage-value">{metrics.pressure.overall} index</p>
          </div>
        </div>
        <div className="surge-stage-status">
          <ShieldAlert size={16} className={analysis.conflicts.length ? 'text-alert' : 'text-secondary'} aria-hidden="true" />
          <div>
            <p className="surge-stage-label">Conflicts</p>
            <p className="surge-stage-value">{analysis.conflicts.length} detected</p>
          </div>
        </div>
        <div className="surge-stage-status">
          <ClipboardList size={16} className="text-secondary" aria-hidden="true" />
          <div>
            <p className="surge-stage-label">Last analysis</p>
            <p className="surge-stage-value">{stored ? new Date(stored.generatedAt).toLocaleTimeString() : 'Not run yet'}</p>
          </div>
        </div>

        <div className="surge-actions">
          <button type="button" className="btn btn-primary" onClick={runAnalysis} disabled={running}>
            <SlidersHorizontal size={16} aria-hidden="true" />
            {running ? 'ANALYSING…' : 'OPTIMIZE RESOURCES'}
          </button>
        </div>
      </section>

      {/* ---------------------------------------------------------- constraints */}
      <Panel title="Constraints" icon={TriangleAlert} subtitle="What limits the hospital right now">
        <div className="constraint-grid">
          {constraints.map((row) => (
            <div className="constraint" key={row.id}>
              <div className="constraint-head">
                <row.icon size={14} className="text-secondary" aria-hidden="true" />
                <span className="constraint-label">{row.label}</span>
                <StatusBadge status={row.severity} size="sm" />
              </div>
              <div className="constraint-value is-blue">{row.value}</div>
            </div>
          ))}
        </div>
      </Panel>

      {/* ------------------------------------------------------ recommendations */}
      <Panel
        title="Recommendations"
        icon={SlidersHorizontal}
        subtitle={stored ? `Generated ${new Date(stored.generatedAt).toLocaleTimeString()} · review required before anything is applied` : 'Run the analysis to generate recommendations'}
      >
        {conflictError ? (
          <div
            className="alert alert-danger"
            style={{
              marginBottom: 16,
              padding: '12px 16px',
              borderRadius: 6,
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              color: '#fca5a5',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <ShieldAlert size={18} color="#ef4444" aria-hidden="true" />
              <span>{conflictError}</span>
            </div>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => {
                setConflictError('');
                runAnalysis();
              }}
            >
              Recalculate
            </button>
          </div>
        ) : null}

        {running ? (
          <p className="panel-note">Analysing demand, capacity, staffing, theatre and equipment together…</p>
        ) : (
          <ul className="recommendation-list">
            {analysis.recommendations.map((recommendation) => {
              const isRej = rejectedIds.includes(recommendation.id);
              const isApp = approvedIds.includes(recommendation.id);

              return (
                <li
                  key={recommendation.id}
                  className={`recommendation ${isRej ? 'is-rejected' : isApp ? 'is-confirmed' : ''}`}
                >
                  <div className="recommendation-main">
                    <div className="recommendation-head">
                      <span className="recommendation-title">{recommendation.title}</span>
                      <span className="badge badge-neutral text-xs">{recommendation.resource}</span>
                      {isRej ? (
                        <StatusBadge status="Rejected" size="sm" />
                      ) : isApp ? (
                        <StatusBadge status="Confirmed" label="Applied" size="sm" />
                      ) : recommendation.requiresApproval ? (
                        <StatusBadge status="Pending Review" size="sm" />
                      ) : (
                        <StatusBadge status="Available" label="Informational" size="sm" />
                      )}
                    </div>
                    <p className="recommendation-summary">{recommendation.summary}</p>
                    {isRej ? (
                      <p className="recommendation-rejected">
                        Rejected — {rejected.find((entry) => entry.id === recommendation.id)?.reason}
                      </p>
                    ) : null}
                  </div>
                  <div className="recommendation-side">
                    <span className="recommendation-highlight">{recommendation.highlight}</span>
                    {recommendationActions(recommendation)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {/* ------------------------------------------------------ projected impact */}
      <section className="grid-2">
        <Panel title="Projected impact" icon={CheckCircle2} subtitle="If the recommended allocation is confirmed">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col">Current</th>
                  <th scope="col">Projected</th>
                </tr>
              </thead>
              <tbody>
                {analysis.impact.map((row) => (
                  <tr key={row.label}>
                    <td className="cell-strong">{row.label}</td>
                    <td className="text-secondary">{row.before}{row.unit ? ` ${row.unit}` : ''}</td>
                    <td className={row.after < row.before ? 'text-success' : row.after > row.before ? 'text-alert' : ''}>
                      {row.after}
                      {row.unit ? ` ${row.unit}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <div className="stack-lg">
          <Panel
            title="Multi-resource conflicts"
            icon={ShieldAlert}
            subtitle={`${analysis.conflicts.length} detected · coordination review only`}
            linkTo="/command/alerts"
            linkLabel="Alert centre"
          >
            <ul className="conflict-list">
              {analysis.conflicts.slice(0, 3).map((conflict) => (
                <li key={conflict.id}>
                  <span className={`status-dot ${conflict.severity === 'Critical' ? 'is-alert' : 'is-info'}`} aria-hidden="true" />
                  <span className="conflict-list-text">
                    <span className="conflict-list-title">{conflict.title}</span>
                    <span className="conflict-list-meta">{conflict.summary || conflict.resource}</span>
                  </span>
                  <StatusBadge status={conflict.severity} size="sm" />
                </li>
              ))}
            </ul>
            <p className="panel-note">
              MediCore never cancels treatment or moves patients. Recommendations are provisional and require authorised
              confirmation.
            </p>
          </Panel>

          <Panel title="Analysis detail" icon={ClipboardList} subtitle="Demand against capacity for each resource class">
            <DataTable
              columns={[
                { key: 'resource', header: 'Resource', strong: true },
                { key: 'demand', header: 'Demand' },
                { key: 'capacity', header: 'Capacity' },
                { key: 'gap', header: 'Gap' },
              ]}
              rows={analysis.analysisRows}
              getRowKey={(row) => row.resource}
              compact
            />
          </Panel>
        </div>
      </section>

      {stored ? (
        <Panel title="Decision" icon={ClipboardList} subtitle={`Recommendation ${stored.id} · raised for the resource coordinator`}>
          <div className="row row-tight">
            <button type="button" className="btn btn-outline" onClick={() => setReviewing(stored)}>
              Review analysis
            </button>
            <Link className="btn btn-outline" to="/command/queue">
              Check the queue first
            </Link>
            {isAuthorized ? (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => handleApprove(stored.recommendations?.[0])}
                  disabled={!stored.recommendations?.length || approvingId || approvedIds.includes(stored.recommendations?.[0]?.id)}
                >
                  <CheckCircle2 size={14} aria-hidden="true" />
                  {approvedIds.includes(stored.recommendations?.[0]?.id)
                    ? 'Recommendation applied'
                    : approvingId
                      ? 'Applying…'
                      : 'Approve recommendation'}
                </button>
                <button
                  type="button"
                  className="btn btn-critical"
                  onClick={() => setRejectModal(stored.recommendations?.[0])}
                  disabled={!stored.recommendations?.length || rejectedIds.includes(stored.recommendations?.[0]?.id)}
                >
                  <XCircle size={14} aria-hidden="true" />
                  Reject recommendation
                </button>
              </>
            ) : null}
            <span className="text-xs text-secondary">
              Authorised command center or resource coordinator confirmation applies allocations across resources.
            </span>
          </div>
        </Panel>
      ) : null}

      <DemoRoleSwitcher
        target="RES001"
        label="Continue as Resource Coordinator"
        description="Review the recommendation and confirm the allocation. Hospital state is preserved."
      />

      <DetailModal
        open={Boolean(reviewing)}
        onClose={() => setReviewing(null)}
        title={reviewing?.title || reviewing?.id || 'Recommendation'}
        subtitle={reviewing?.summary}
        size="md"
        badge={
          reviewing ? (
            <>
              <span className="badge badge-neutral text-xs">{reviewing.resource}</span>
              {rejectedIds.includes(reviewing.id) ? (
                <StatusBadge status="Rejected" size="sm" />
              ) : approvedIds.includes(reviewing.id) ? (
                <StatusBadge status="Confirmed" label="Applied" size="sm" />
              ) : reviewing.requiresApproval ? (
                <span className="badge badge-high text-xs">Review required</span>
              ) : (
                <span className="badge badge-neutral text-xs">Informational</span>
              )}
            </>
          ) : null
        }
        footer={
          reviewing && isAuthorized && !rejectedIds.includes(reviewing.id) && !approvedIds.includes(reviewing.id) ? (
            <div className="row row-tight">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  handleApprove(reviewing);
                  setReviewing(null);
                }}
              >
                <CheckCircle2 size={14} aria-hidden="true" />
                Approve & Apply
              </button>
              <button
                type="button"
                className="btn btn-critical"
                onClick={() => {
                  const target = reviewing;
                  setReviewing(null);
                  setRejectModal(target);
                }}
              >
                <XCircle size={14} aria-hidden="true" />
                Reject
              </button>
            </div>
          ) : null
        }
      >
        {reviewing?.rationale?.length ? (
          <ul className="rationale-list">
            {reviewing.rationale.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {reviewing?.impactRows?.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <tbody>
                {reviewing.impactRows.map((row) => (
                  <tr key={row.label}>
                    <td className="cell-strong">{row.label}</td>
                    <td className="text-secondary">{row.before}</td>
                    <td className="text-success">{row.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="text-small text-secondary">
          Stethoscope cover, nursing allocation and equipment reservations linked to this recommendation are applied together
          when confirmed.
        </p>
      </DetailModal>

      <ConfirmationModal
        open={Boolean(rejectModal)}
        title={rejectModal ? `Reject ${rejectModal.id}` : 'Reject recommendation'}
        subtitle={rejectModal?.title || 'Operational recommendation'}
        tone="critical"
        confirmLabel="Reject recommendation"
        requireReason={true}
        reasonLabel="Reason:"
        reasonPlaceholder="Record why this recommendation cannot be applied — alternative escalation required"
        onClose={() => setRejectModal(null)}
        onConfirm={({ reason }) => {
          if (rejectModal) {
            actions.rejectRecommendation(rejectModal.id, reason || 'Rejected at command center');
            setRejectModal(null);
          }
        }}
        consequences={[
          'The recommendation stays in the review audit trail with the recorded reason.',
          'No beds, staff, or equipment are moved for this recommendation.',
          'Command staff can re-run optimization or choose an alternative escalation path.',
        ]}
      />
    </div>
  );
}

