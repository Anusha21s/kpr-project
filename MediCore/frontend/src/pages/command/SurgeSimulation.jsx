import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BedDouble,
  HeartPulse,
  Package,
  RotateCcw,
  SlidersHorizontal,
  TriangleAlert,
  Users,
  Zap,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import StatusBadge from '../../components/StatusBadge';
import DataTable from '../../components/DataTable';
import { useHospital } from '../../hooks/useHospital';
import { buildSnapshot } from '../../utils/simulationEngine';
import { rankQueue } from '../../utils/optimizationEngine';
import { AXIS_PROPS, CHART_COLORS, GRID_PROPS, TOOLTIP_STYLE } from '../../utils/chartTheme';
import { SURGE_BATCH } from '../../data/patients';

const STAGES = [
  'Receiving mass-casualty intake…',
  'Registering 20 additional emergency patients…',
  'Applying provisional resource holds…',
  'Recomputing hospital state across all resources…',
];

/**
 * Surge Simulation (section 19) — the demonstration flow.
 *
 * Normal → SIMULATE EMERGENCY SURGE → pressure across resources →
 * OPTIMIZE RESOURCES → recommended allocation → expected impact.
 * Explanatory prose was removed; the workflow itself carries the story.
 */
export default function SurgeSimulation() {
  const { state, metrics, actions } = useHospital();
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState(0);

  const baseline = state.simulationHistory.before || buildSnapshot(state, 'Normal');
  const surged = state.surge.active ? state.simulationHistory.after || buildSnapshot(state, 'Surge') : null;
  const isOptimized = Boolean(state.surge.processed);
  const optimization = state.optimization || null;
  const recommended = optimization ? optimization.recommended : null;
  const impact = optimization ? optimization.impact : [];
  const allocationLines = optimization
    ? optimization.recommendations
        .filter((entry) => ['REC-BED-01', 'REC-ICU-01', 'REC-DOC-01', 'REC-NUR-01', 'REC-EQP-01'].includes(entry.id))
        .map((entry) => ({ id: entry.id, label: entry.resource, value: entry.highlight }))
    : [];

  const runSurge = () => {
    setRunning(true);
    setStage(0);
    STAGES.forEach((_, index) => window.setTimeout(() => setStage(index), index * 340));
    window.setTimeout(() => {
      actions.runSurge();
      setRunning(false);
    }, STAGES.length * 340);
  };

  const comparison = [
    { metric: 'Emergency queue', normal: baseline.emergencyQueue, surge: surged ? surged.emergencyQueue : metrics.queue.total, optimized: recommended ? recommended.emergencyQueue : null, unit: 'patients' },
    { metric: 'Critical waiting', normal: baseline.criticalQueue, surge: surged ? surged.criticalQueue : metrics.queue.critical, optimized: recommended ? recommended.criticalQueue : null, unit: '' },
    { metric: 'ICU occupancy', normal: baseline.icuOccupancy, surge: surged ? surged.icuOccupancy : metrics.beds.icu.occupancyPercentage, optimized: recommended ? recommended.icuOccupancy : null, unit: '%' },
    { metric: 'ICU beds vacant', normal: baseline.icuAvailable, surge: surged ? surged.icuAvailable : metrics.beds.icu.available, optimized: recommended ? recommended.icuAvailable : null, unit: '' },
    { metric: 'Beds available', normal: baseline.availableBeds, surge: surged ? surged.availableBeds : metrics.beds.available, optimized: recommended ? recommended.availableBeds : null, unit: '' },
    { metric: 'Nurse workload', normal: baseline.nurseWorkload, surge: surged ? surged.nurseWorkload : metrics.nurses.workloadIndex, optimized: recommended ? recommended.nurseWorkload : null, unit: '%' },
    { metric: 'Overall pressure', normal: baseline.pressure, surge: surged ? surged.pressure : metrics.pressure.overall, optimized: recommended ? recommended.pressure : null, unit: ' index' },
  ];

  const pressureChart = metrics.pressure.resources.map((resource) => ({
    name: resource.label.split(' ')[0],
    Normal: Math.round(baseline.pressure * (0.9 + resource.pressure / 900)),
    Surge: resource.pressure,
    Optimized: recommended ? Math.max(12, Math.round(resource.pressure * 0.62)) : 0,
  }));

  const intakeByResource = SURGE_BATCH.reduce((accumulator, entry) => {
    accumulator[entry.requiredResource] = (accumulator[entry.requiredResource] || 0) + 1;
    return accumulator;
  }, {});

  return (
    <div className="page">
      {/* ------------------------------------------------------- current stage */}
      <section className="surge-stage">
        <div className="surge-stage-status">
          <span className={`status-dot ${state.surge.active ? 'is-alert' : 'is-success'}`} aria-hidden="true" />
          <div>
            <p className="surge-stage-label">Hospital status</p>
            <p className={`surge-stage-value ${state.surge.active ? 'is-alert' : 'is-ok'}`}>
              {isOptimized ? 'Optimized' : state.surge.active ? 'Surge' : 'Normal'}
            </p>
          </div>
        </div>
        <div className="surge-stage-status">
          <TriangleAlert size={16} className="text-secondary" aria-hidden="true" />
          <div>
            <p className="surge-stage-label">Emergency queue</p>
            <p className="surge-stage-value">
              {baseline.emergencyQueue}
              {surged ? <span className="surge-stage-arrow"> → {surged.emergencyQueue}</span> : null}
            </p>
          </div>
        </div>
        <div className="surge-stage-status">
          <HeartPulse size={16} className="text-secondary" aria-hidden="true" />
          <div>
            <p className="surge-stage-label">ICU</p>
            <p className="surge-stage-value">{metrics.beds.icu.available} vacant of {metrics.beds.icu.units}</p>
          </div>
        </div>
        <div className="surge-stage-status">
          <Users size={16} className="text-secondary" aria-hidden="true" />
          <div>
            <p className="surge-stage-label">Nurses</p>
            <p className="surge-stage-value">{metrics.nurses.available} available · {metrics.nurses.atConstraint} at limit</p>
          </div>
        </div>

        <div className="surge-actions">
          {!state.surge.active ? (
            <button type="button" className="btn btn-critical" onClick={runSurge} disabled={running}>
              <Zap size={16} aria-hidden="true" />
              {running ? 'SURGE DETECTED — processing' : 'SIMULATE EMERGENCY SURGE'}
            </button>
          ) : (
            <Link className="btn btn-primary" to="/command/optimization">
              <SlidersHorizontal size={16} aria-hidden="true" />
              OPTIMIZE RESOURCES
            </Link>
          )}
          {state.surge.active ? (
            <button type="button" className="btn btn-outline btn-sm" onClick={actions.resetDemo}>
              <RotateCcw size={13} aria-hidden="true" />
              Reset simulation
            </button>
          ) : null}
        </div>
      </section>

      {running ? (
        <div className="alert-line is-critical" role="status" aria-live="polite">
          <div className="alert-line-main">
            <span className="alert-line-title">SURGE DETECTED</span>
            <span className="alert-line-meta">{STAGES[Math.min(stage, STAGES.length - 1)]}</span>
          </div>
          <div className="bar" style={{ width: 140 }}>
            <span className="bar-fill is-alert" style={{ width: `${((stage + 1) / STAGES.length) * 100}%` }} />
          </div>
        </div>
      ) : null}

      {/* ------------------------------------------------------ surge pressure */}
      {state.surge.active ? (
        <>
          <section className="kpi-row" aria-label="Surge position">
            <KpiTile label="Emergency queue" icon={TriangleAlert} tone="alert" value={metrics.queue.total} caption={`was ${baseline.emergencyQueue} before the surge`} progress={(metrics.queue.total / 40) * 100} />
            <KpiTile label="Critical waiting" icon={HeartPulse} tone="alert" value={metrics.queue.critical} caption={`was ${baseline.criticalQueue}`} />
            <KpiTile label="ICU" icon={HeartPulse} tone={metrics.beds.icu.available <= 1 ? 'alert' : 'teal'} value={metrics.beds.icu.available} caption="vacant — higher pressure" progress={metrics.beds.icu.occupancyPercentage} />
            <KpiTile label="Beds available" icon={BedDouble} tone="alert" value={metrics.beds.available} caption="reduced availability" progress={metrics.beds.occupancyPercentage} />
            <KpiTile label="Nurses available" icon={Users} tone="alert" value={metrics.nurses.available} caption={`${metrics.nurses.atConstraint} at workload limit`} />
            <KpiTile label="Ventilators free" icon={Package} tone="alert" value={metrics.equipment.ventilators.available} caption={`${metrics.queue.ventilatorRequests} cases need ventilation`} />
          </section>

          <section className="grid-2">
            <Panel title="Before · surge · optimized" icon={Zap} subtitle="Every constrained resource, measured together">
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Metric</th>
                      <th scope="col">Normal</th>
                      <th scope="col">Surge</th>
                      <th scope="col">Optimized</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.map((row) => (
                      <tr key={row.metric}>
                        <td className="cell-strong">{row.metric}</td>
                        <td className="text-secondary">{row.normal}{row.unit}</td>
                        <td className="text-alert">{row.surge}{row.unit}</td>
                        <td className={row.optimized === null ? 'text-secondary' : 'text-success'}>
                          {row.optimized === null ? '—' : `${row.optimized}${row.unit}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="Resource pressure" icon={TriangleAlert} subtitle="Normal versus surge versus optimized">
              <div className="chart-box" style={{ height: 250 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={pressureChart} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
                    <CartesianGrid {...GRID_PROPS} />
                    <XAxis dataKey="name" {...AXIS_PROPS} tick={{ fill: CHART_COLORS.axis, fontSize: 10 }} />
                    <YAxis {...AXIS_PROPS} domain={[0, 100]} />
                    <Tooltip {...TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="Normal" fill={CHART_COLORS.success} radius={[3, 3, 0, 0]} />
                    <Bar dataKey="Surge" fill={CHART_COLORS.alert} radius={[3, 3, 0, 0]} />
                    {recommended ? <Bar dataKey="Optimized" fill={CHART_COLORS.blue} radius={[3, 3, 0, 0]} /> : null}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </section>

          {recommended ? (
            <Panel
              title="Recommended allocation"
              icon={SlidersHorizontal}
              subtitle="Awaiting confirmation by the resource coordinator"
              linkTo="/resources/approvals"
              linkLabel="Pending approvals"
            >
              <ul className="allocation-list">
                {allocationLines.map((row) => (
                  <li key={row.id}>
                    <span className="allocation-label">{row.label}</span>
                    <span className="allocation-value">{row.value}</span>
                  </li>
                ))}
              </ul>
              <p className="panel-note">
                Expected operational impact: emergency queue{' '}
                {impact.find((row) => row.label.startsWith('Emergency queue'))?.before ?? metrics.queue.total} →{' '}
                {impact.find((row) => row.label.startsWith('Emergency queue'))?.after ?? metrics.queue.total}. Nothing is
                applied until the coordinator confirms it.
              </p>
            </Panel>
          ) : (
            <div className="alert-line is-operational">
              <div className="alert-line-main">
                <span className="alert-line-title">Surge registered across {Object.keys(intakeByResource).length} resource classes</span>
                <span className="alert-line-meta">
                  {Object.entries(intakeByResource).map(([resource, count]) => `${count} × ${resource}`).join(' · ')}
                </span>
              </div>
              <Link className="btn btn-primary btn-sm" to="/command/optimization">
                Optimize resources
                <ArrowRight size={13} aria-hidden="true" />
              </Link>
            </div>
          )}

          <Panel
            title="Surge intake"
            icon={TriangleAlert}
            subtitle={`${SURGE_BATCH.length} patients added · priority order`}
            linkTo="/command/queue"
            linkLabel="Full queue"
          >
            <DataTable
              columns={[
                { key: 'id', header: 'Patient', strong: true, render: (row) => <span className="mono">{row.id}</span> },
                { key: 'priority', header: 'Priority', render: (row) => <StatusBadge status={row.priority} size="sm" /> },
                { key: 'requiredResource', header: 'Requires' },
                { key: 'specialtyRequired', header: 'Specialty' },
                { key: 'waitingMinutes', header: 'Waiting', render: (row) => `${row.waitingMinutes} min` },
              ]}
              rows={rankQueue(state.queue).slice(0, 6)}
              getRowKey={(row) => row.id}
              emptyTitle="No patients queued"
            />
          </Panel>
        </>
      ) : (
        <Panel title="Ready to model a surge" icon={Zap} subtitle="Deterministic simulation — identical results on every run">
          <p className="panel-note">
            The simulation adds {SURGE_BATCH.length} emergency patients with a fixed resource mix, holds the remaining monitored
            capacity for the incoming critical arrivals and recalculates every constraint.
          </p>
        </Panel>
      )}
    </div>
  );
}

