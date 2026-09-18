/**
 * HE-02 AI service client.
 *
 * The only place in the Node backend that speaks to the Python model service.
 * It is deliberately defensive: the hospital system must keep working when the
 * model service is slow, restarting or simply not deployed.
 *
 *   · every call is bounded by a timeout (AbortController)
 *   · a circuit breaker stops hammering a service that is down
 *     (3 consecutive failures → open for 15 s, then one probe)
 *   · failures surface as `AiUnavailableError`, which callers translate into a
 *     labelled fallback — never into a 500 for the user
 *   · nothing here touches the database or the socket layer
 */

const env = require('../config/env');
const logger = require('../utils/logger');

const FAILURE_THRESHOLD = 3;
const OPEN_MS = 15000;

class AiUnavailableError extends Error {
  constructor(message, { cause = null, status = 0, endpoint = '' } = {}) {
    super(message);
    this.name = 'AiUnavailableError';
    this.cause = cause;
    this.status = status;
    this.endpoint = endpoint;
  }
}

const state = {
  enabled: env.aiServiceEnabled,
  baseUrl: env.aiServiceUrl,
  failures: 0,
  openedAt: 0,
  calls: 0,
  lastOkAt: null,
  lastErrorAt: null,
  lastError: null,
  lastLatencyMs: null,
};

const breakerOpen = () => state.openedAt > 0 && Date.now() - state.openedAt < OPEN_MS;

/** Circuit-breaker bookkeeping. */
function recordSuccess(latencyMs) {
  state.calls += 1;
  state.failures = 0;
  state.openedAt = 0;
  state.lastOkAt = new Date().toISOString();
  state.lastLatencyMs = latencyMs;
}

function recordFailure(error, endpoint) {
  state.calls += 1;
  state.failures += 1;
  state.lastErrorAt = new Date().toISOString();
  state.lastError = `${endpoint}: ${error.message}`;
  if (state.failures >= FAILURE_THRESHOLD && state.openedAt === 0) {
    state.openedAt = Date.now();
    logger.warn(`AI service circuit breaker opened after ${state.failures} failures — hospital logic continues without models`);
  }
}

/** Public view of the client's health, used by the API health endpoints. */
const state$ = () => ({
  enabled: state.enabled,
  baseUrl: state.baseUrl,
  calls: state.calls,
  failures: state.failures,
  lastOkAt: state.lastOkAt,
  lastErrorAt: state.lastErrorAt,
  lastError: state.lastError,
  lastLatencyMs: state.lastLatencyMs,
  circuitBreakerOpen: breakerOpen(),
  reachable: Boolean(state.lastOkAt) && !breakerOpen(),
});

/**
 * Performs one bounded request against the AI service.
 * @throws {AiUnavailableError} when disabled, tripped, unreachable, timed out or returning 5xx
 */
async function request(path, { method = 'POST', body, timeoutMs = env.aiServiceTimeoutMs } = {}) {
  if (!state.enabled) {
    throw new AiUnavailableError('the AI service is disabled in this environment', { endpoint: path });
  }
  if (breakerOpen()) {
    const waitMs = Math.max(0, OPEN_MS - (Date.now() - state.openedAt));
    throw new AiUnavailableError(
      `the AI service circuit breaker is open — retrying in ${Math.ceil(waitMs / 1000)}s`,
      { endpoint: path },
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(`${state.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      signal: controller.signal,
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const detail = (payload && payload.error && payload.error.message) || `HTTP ${response.status}`;
      const error = new AiUnavailableError(`the AI service rejected the request (${response.status}): ${detail}`, {
        status: response.status,
        endpoint: path,
      });
      /* A 4xx is a contract problem, not an outage: it must not trip the breaker
         in a way that hides a genuine bug, but the caller still gets a fallback. */
      if (response.status >= 500) recordFailure(error, path);
      throw error;
    }

    recordSuccess(Date.now() - startedAt);
    return payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
  } catch (error) {
    const failure =
      error instanceof AiUnavailableError
        ? error
        : new AiUnavailableError(
            error.name === 'AbortError'
              ? `the AI service did not answer within ${timeoutMs} ms`
              : `the AI service is unreachable (${error.message})`,
            { cause: error, endpoint: path },
          );
    if (!(error instanceof AiUnavailableError) || error.status === 0 || error.status >= 500) {
      recordFailure(failure, path);
    }
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

/** A snapshot-only inference call: the Node snapshot is the whole request body. */
const withSnapshot = (path) => (snapshot, { persistHistory = true, explain = true } = {}) =>
  request(path, { body: { snapshot, persist_history: persistHistory, explain } });

module.exports = {
  AiUnavailableError,
  state: state$,
  health: () => request('/api/ai/health', { method: 'GET' }),
  models: () => request('/api/ai/models', { method: 'GET' }),
  reload: () => request('/api/ai/maintenance/reload', { method: 'POST', body: {} }),

  demandForecast: withSnapshot('/api/ai/demand/forecast'),
  resourceForecast: withSnapshot('/api/ai/resources/forecast'),
  surgeDetect: withSnapshot('/api/ai/surge/detect'),
  pressurePredict: withSnapshot('/api/ai/pressure/predict'),
  doctorWorkload: withSnapshot('/api/ai/doctor-workload/predict'),
  nurseWorkload: withSnapshot('/api/ai/nurse-workload/predict'),
  equipmentDemand: withSnapshot('/api/ai/equipment-demand/predict'),
  patientFlow: withSnapshot('/api/ai/patient-flow/predict'),

  optimize: (problem) => request('/api/ai/optimize', { body: problem, timeoutMs: env.aiServiceAdvisoryTimeoutMs }),
  simulate: (simulationRequest) =>
    request('/api/ai/simulate', { body: simulationRequest, timeoutMs: env.aiServiceAdvisoryTimeoutMs }),
  advisory: (advisoryRequest) =>
    request('/api/ai/advisory', { body: advisoryRequest, timeoutMs: env.aiServiceAdvisoryTimeoutMs }),
  recordSnapshot: (snapshot) => request('/api/ai/snapshot', { body: { snapshot } }),
};
