/**
 * MediCore — operational data service.
 *
 * The backend (`/api/…`) is the source of operational data. This module is the
 * only place that knows *how* data arrives:
 *
 *   1. If the backend answers, its payload is used.
 *   2. If it does not (demo / offline judging), the deterministic local data
 *      layer and simulation engine answer instead, using the same shapes.
 *
 * No component is aware of which path was taken — they all receive the same
 * `{ data, source, error }` envelope from `useHospitalData`.
 */

import api, { ApiError, BACKEND_CONFIGURED, ENDPOINTS, getToken } from './api';
import { connectSocket } from './socket';
import { createInitialState } from '../utils/hospitalState';
import {
  buildSnapshot,
  calculateHospitalMetrics,
  calculateResourcePressure,
} from '../utils/simulationEngine';
import { detectConflicts } from '../utils/optimizationEngine';

export const SOURCE = { BACKEND: 'backend', DEMO: 'demo' };

const ok = (data, source = SOURCE.DEMO) => ({ data, source, error: null });
const failed = (error, fallback, source = SOURCE.DEMO) => ({ data: fallback, source, error });

/** Demo payload used whenever the backend is unavailable. */
export function demoSnapshot() {
  const state = createInitialState();
  return {
    ...buildSnapshot(state),
    metrics: calculateHospitalMetrics(state),
    pressure: calculateResourcePressure(state),
    alerts: state.alerts,
    activity: state.activity || [],
    approvals: state.approvals || [],
    allocations: state.allocations || [],
    conflicts: state.conflicts || [],
    otRooms: state.otRooms || [],
    otBacklog: state.otBacklog || [],
    clinicalTasks: state.clinicalTasks || [],
  };
}

/** Single call used by the shell: dashboard overview + shared operational state. */
export async function fetchOverview({ signal } = {}) {
  /* No backend declared for this deployment → answer from the local data layer
     immediately, without a failing request. */
  if (!BACKEND_CONFIGURED) return ok(demoSnapshot(), SOURCE.DEMO);
  const token = getToken();
  if (!token) return ok(demoSnapshot(), SOURCE.DEMO);
  try {
    const data = await api.overview({ signal });
    return ok(data, SOURCE.BACKEND);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return ok(demoSnapshot(), SOURCE.DEMO);
    return failed(error, demoSnapshot());
  }
}

export async function fetchCollection(key, { signal, query } = {}) {
  const call = {
    patients: () => api.patients(query, { signal }),
    queue: () => api.queue(query, { signal }),
    beds: () => api.beds({ signal }),
    doctors: () => api.doctors({ signal }),
    nurses: () => api.nurses({ signal }),
    equipment: () => api.equipment({ signal }),
    emergencyResources: () => api.emergencyResources({ signal }),
    ot: () => api.ot({ signal }),
    allocations: () => api.allocations({ signal }),
    alerts: () => api.alerts(query, { signal }),
    notifications: () => api.notifications({ signal }),
  }[key];

  const fallback = demoSnapshot();
  if (!call || !BACKEND_CONFIGURED) return ok(fallback, SOURCE.DEMO);
  const token = getToken();
  if (!token) return ok(fallback, SOURCE.DEMO);
  try {
    return ok(await call(), SOURCE.BACKEND);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return ok(fallback, SOURCE.DEMO);
    return failed(error, fallback);
  }
}

/** POST /api/simulation — deterministic locally if the backend is absent. */
export async function postSimulation(body) {
  try {
    return ok(await api.runSimulation(body), SOURCE.BACKEND);
  } catch (error) {
    return failed(error, { simulation: body, accepted: false });
  }
}

/** POST /api/optimization — multi-resource recommendation request. */
export async function postOptimization(body) {
  try {
    return ok(await api.optimize(body), SOURCE.BACKEND);
  } catch (error) {
    return failed(error, { recommendationBoard: buildRecommendationBoard(body) });
  }
}

/**
 * Decision-support board: the resource coordinator receives the recommendation
 * set together with the conflicts the engine detected across resources.
 */
export function buildRecommendationBoard(state) {
  return {
    recommendations: (state.optimization && state.optimization.recommendations) || [],
    conflicts: detectConflicts(state),
  };
}

export const service = {
  endpoints: ENDPOINTS,
  connect: () => connectSocket({ token: getToken() }),
  demoSnapshot,
  fetchOverview,
  fetchCollection,
  postSimulation,
  postOptimization,
};

export { ApiError };
export default service;
