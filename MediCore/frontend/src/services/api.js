/**
 * MediCore — centralised API client.
 *
 * Every network call in the application goes through this module. Components
 * never call `fetch` directly (section 33). The client is deliberately small:
 *   · one base URL (VITE_API_BASE_URL, default `/api`)
 *   · bearer-token aware
 *   · JSON in / JSON out
 *   · typed error object so the UI can show a short, non-technical message
 *
 * The Node/Express backend exposes exactly the endpoints listed in
 * `ENDPOINTS` below. When a backend is not running the demo data layer in
 * `hospitalService.js` answers instead, so the prototype stays fully
 * demonstrable without a server.
 */

const CONFIGURED_BASE = (import.meta && import.meta.env && import.meta.env.VITE_API_BASE_URL) || '';
const RAW_BASE = CONFIGURED_BASE || '/api';

export const API_BASE_URL = RAW_BASE.replace(/\/$/, '');

/**
 * True only when the deployment declares a backend (`VITE_API_BASE_URL`).
 * The frontend-only demo leaves it unset, so service modules answer from the
 * local data layer instead of calling endpoints that are not deployed.
 */
export const BACKEND_CONFIGURED = Boolean(CONFIGURED_BASE);

/** Endpoint map — one place to change if the backend routes move. */
export const ENDPOINTS = {
  auth: `${API_BASE_URL}/auth`,
  login: `${API_BASE_URL}/auth/login`,
  logout: `${API_BASE_URL}/auth/logout`,
  me: `${API_BASE_URL}/auth/me`,
  overview: `${API_BASE_URL}/dashboard/overview`,
  patients: `${API_BASE_URL}/patients`,
  queue: `${API_BASE_URL}/queue`,
  beds: `${API_BASE_URL}/beds`,
  doctors: `${API_BASE_URL}/doctors`,
  nurses: `${API_BASE_URL}/nurses`,
  equipment: `${API_BASE_URL}/equipment`,
  emergencyResources: `${API_BASE_URL}/emergency-resources`,
  ot: `${API_BASE_URL}/ot`,
  simulation: `${API_BASE_URL}/simulation`,
  optimization: `${API_BASE_URL}/optimization`,
  allocations: `${API_BASE_URL}/allocations`,
  alerts: `${API_BASE_URL}/alerts`,
  notifications: `${API_BASE_URL}/notifications`,
};

const TOKEN_KEY = 'medicore.token.v1';

export class ApiError extends Error {
  constructor(message, { status = 0, endpoint = '', cause = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.endpoint = endpoint;
    this.cause = cause;
    this.offline = status === 0;
  }
}

export function getToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — token stays in memory for the session only */
  }
}

export function clearToken() {
  setToken(null);
}

function buildUrl(endpoint, query) {
  if (!query || !Object.keys(query).length) return endpoint;
  const search = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    search.append(key, String(value));
  });
  const suffix = search.toString();
  return suffix ? `${endpoint}?${suffix}` : endpoint;
}

/**
 * Core request helper. Never throws a raw fetch/network error at the UI —
 * everything is normalised into an `ApiError` with a readable message.
 */
export async function request(endpoint, { method = 'GET', body, query, signal, timeout = 8000 } = {}) {
  const url = buildUrl(endpoint, query);
  const token = getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 204) return null;

    const isJson = (response.headers.get('content-type') || '').includes('application/json');
    const payload = isJson ? await response.json() : await response.text();

    if (!response.ok) {
      const message =
        (payload && payload.error && payload.error.message) ||
        (payload && payload.message) ||
        (payload && typeof payload.error === 'string' ? payload.error : null) ||
        (response.status === 401 ? 'Your session has expired. Sign in again.' : 'Request could not be completed.');
      const err = new ApiError(message, { status: response.status, endpoint: url });
      if (payload && payload.error) err.details = payload.error;
      throw err;
    }
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const offline = error.name === 'AbortError' || error.name === 'TypeError';
    throw new ApiError(offline ? 'Hospital data service is unreachable.' : 'Request could not be completed.', {
      status: 0,
      endpoint: url,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  get: (endpoint, options) => request(endpoint, { ...options, method: 'GET' }),
  post: (endpoint, body, options) => request(endpoint, { ...options, method: 'POST', body }),
  patch: (endpoint, body, options) => request(endpoint, { ...options, method: 'PATCH', body }),
  del: (endpoint, options) => request(endpoint, { ...options, method: 'DELETE' }),

  /* ---------------------------------------------------------------- endpoints */
  login: (credentials) => request(ENDPOINTS.login, { method: 'POST', body: credentials }),
  logout: () => request(ENDPOINTS.logout, { method: 'POST' }),
  session: (options) => api.get(ENDPOINTS.me, options),
  overview: (options) => api.get(ENDPOINTS.overview, options),
  patients: (query, options) => api.get(ENDPOINTS.patients, { query, ...options }),
  createPatient: (body) => api.post(ENDPOINTS.patients, body),
  updatePatient: (id, body) => api.patch(`${ENDPOINTS.patients}/${id}`, body),
  dischargePatient: (id, body) => api.post(`${ENDPOINTS.patients}/${id}/discharge`, body || {}),
  queue: (query, options) => api.get(ENDPOINTS.queue, { query, ...options }),
  beds: (options) => api.get(ENDPOINTS.beds, options),
  assignBed: (bedId, body) => api.post(`${ENDPOINTS.beds}/${bedId}/assign`, body),
  releaseBed: (bedId, body) => api.post(`${ENDPOINTS.beds}/${bedId}/release`, body),
  doctors: (options) => api.get(ENDPOINTS.doctors, options),
  nurses: (options) => api.get(ENDPOINTS.nurses, options),
  equipment: (options) => api.get(ENDPOINTS.equipment, options),
  reserveEquipment: (body) => api.post(`${ENDPOINTS.equipment}/reserve`, body),
  releaseEquipment: (body) => api.post(`${ENDPOINTS.equipment}/release`, body),
  emergencyResources: (options) => api.get(ENDPOINTS.emergencyResources, options),
  ot: (options) => api.get(ENDPOINTS.ot, options),
  holdOt: (theatreId, body) => api.post(`${ENDPOINTS.ot}/${theatreId}/hold`, body || {}),
  releaseOt: (theatreId, body) => api.post(`${ENDPOINTS.ot}/${theatreId}/release`, body || {}),
  runSimulation: (body) => api.post(ENDPOINTS.simulation, body),
  revertSimulation: () => api.post(`${ENDPOINTS.simulation}/revert`),
  optimize: (body) => api.post(ENDPOINTS.optimization, body),
  approveRecommendation: (id, body) => api.post(`${ENDPOINTS.optimization}/recommendations/${id}/approve`, body || {}),
  rejectRecommendation: (id, body) => api.post(`${ENDPOINTS.optimization}/recommendations/${id}/reject`, body || {}),
  allocations: (options) => api.get(ENDPOINTS.allocations, options),
  approveAllocation: (id, body) => api.post(`${ENDPOINTS.allocations}/${id}/approve`, body || {}),
  rejectAllocation: (id, body) => api.post(`${ENDPOINTS.allocations}/${id}/reject`, body || {}),
  alerts: (query, options) => api.get(ENDPOINTS.alerts, { query, ...options }),
  acknowledgeAlert: (id) => api.post(`${ENDPOINTS.alerts}/${id}/acknowledge`),
  resolveAlert: (id) => api.post(`${ENDPOINTS.alerts}/${id}/resolve`),
  acknowledgeAllAlerts: () => api.post(`${ENDPOINTS.alerts}/acknowledge-all`),
  notifications: (options) => api.get(ENDPOINTS.notifications, options),
};

export default api;

