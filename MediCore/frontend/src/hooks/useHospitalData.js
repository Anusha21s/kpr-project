import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SOURCE,
  demoSnapshot,
  fetchCollection,
  fetchOverview,
  postOptimization,
  postSimulation,
} from '../services/hospitalService';
import { connectSocket, disconnectSocket, onOperationalEvent, onSocketStatus } from '../services/socket';

/**
 * useHospitalData — the single data source for every dashboard.
 *
 * Returns the operational snapshot together with an explicit lifecycle state so
 * API-driven screens can render skeletons (section 35), a short retry state
 * (section 36) and short empty states (section 37) — never a blank screen.
 *
 * While the prototype has no backend running, the deterministic demo snapshot
 * answers immediately and `source` reports 'demo'.
 */
export function useHospitalData({ key = 'overview', query, enabled = true } = {}) {
  const [snapshot, setSnapshot] = useState(() => (key === 'overview' ? demoSnapshot() : null));
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [source, setSource] = useState(SOURCE.DEMO);
  const [error, setError] = useState(null);
  const [socketStatus, setSocketStatus] = useState('idle');
  const [revision, setRevision] = useState(0);
  const mounted = useRef(true);

  const load = useCallback(
    async (signal) => {
      if (!enabled) return;
      setStatus((current) => (current === 'ready' ? 'refreshing' : 'loading'));
      const result = key === 'overview' ? await fetchOverview({ signal }) : await fetchCollection(key, { signal, query });
      if (!mounted.current) return;
      setSnapshot(result.data);
      setSource(result.source);
      setError(result.error);
      setStatus('ready');
    },
    [enabled, key, query],
  );

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    load(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [load, revision]);

  /* ---------------------------------------------- realtime bridge (section 34) */
  useEffect(() => {
    if (!enabled) return undefined;
    connectSocket();
    const offStatus = onSocketStatus(setSocketStatus);
    const offEvent = onOperationalEvent(() => setRevision((value) => value + 1));
    return () => {
      offStatus();
      offEvent();
      disconnectSocket();
    };
  }, [enabled]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  const runSimulation = useCallback(async (body) => {
    setStatus('refreshing');
    const result = await postSimulation(body);
    setRevision((value) => value + 1);
    return result;
  }, []);

  const requestOptimization = useCallback(async (body) => {
    setStatus('refreshing');
    const result = await postOptimization(body);
    setRevision((value) => value + 1);
    return result;
  }, []);

  const value = useMemo(
    () => ({
      snapshot,
      status,
      source,
      error,
      socketStatus,
      refresh,
      runSimulation,
      requestOptimization,
      isLoading: status === 'loading',
      isRefreshing: status === 'refreshing',
      hasError: Boolean(error),
      isOffline: Boolean(error),
      isDemo: source === SOURCE.DEMO,
    }),
    [snapshot, status, source, error, socketStatus, refresh, runSimulation, requestOptimization],
  );

  return value;
}

export default useHospitalData;
