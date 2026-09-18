/** Shared Recharts theming so every chart uses the approved palette. */

export const CHART_COLORS = {
  blue: '#1976D2',
  teal: '#009688',
  success: '#43A047',
  alert: '#E53935',
  neutral: '#607D8B',
  grid: '#E0E6EA',
  axis: '#607D8B',
};

export const AXIS_PROPS = {
  stroke: CHART_COLORS.axis,
  tick: { fill: CHART_COLORS.axis, fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: CHART_COLORS.grid },
};

export const GRID_PROPS = {
  stroke: CHART_COLORS.grid,
  strokeDasharray: '3 3',
  vertical: false,
};

export const TOOLTIP_STYLE = {
  contentStyle: {
    borderRadius: 8,
    border: `1px solid ${CHART_COLORS.grid}`,
    boxShadow: '0 6px 20px rgba(38, 50, 56, 0.1)',
    fontSize: 12,
    padding: '8px 10px',
  },
  labelStyle: { color: '#263238', fontWeight: 600, marginBottom: 4 },
};

export const legendProps = { wrapperStyle: { fontSize: 11.5, color: CHART_COLORS.axis } };

/**
 * Appends the live reading to a seeded trend series so charts always end at the
 * current operational state.
 */
export function withLivePoint(series, label, point) {
  const withoutDuplicate = series.filter((entry) => entry.time !== label);
  return [...withoutDuplicate, { time: label, ...point }];
}

/** Builds a before / surge / optimised comparison from the simulation history. */
export function buildSimulationComparison(simulationHistory, keys) {
  const stages = [
    { key: 'before', label: 'Normal' },
    { key: 'after', label: 'Surge' },
    { key: 'optimized', label: 'Optimized' },
  ];
  return stages
    .filter((stage) => simulationHistory[stage.key])
    .map((stage) => {
      const snapshot = simulationHistory[stage.key];
      const row = { stage: stage.label };
      keys.forEach((item) => {
        row[item.key] = snapshot[item.key];
      });
      return row;
    });
}
