/**
 * MediCore — Socket.IO bridge (section 34).
 *
 * One shared socket connection for the whole application. Operational events
 * (bed changes, staff availability, equipment, queue, surge, optimisation,
 * allocations, alerts) are pushed by the backend and re-dispatched into the
 * hospital store so every dashboard updates without a manual refresh.
 *
 * When no backend is present the bridge stays dormant: the in-app simulation
 * engine keeps the same screens live, and nothing in the UI breaks.
 */

import { io } from 'socket.io-client';

export const OPERATIONAL_EVENTS = [
  'bed:updated',
  'doctor:availability',
  'nurse:availability',
  'equipment:updated',
  'queue:updated',
  'surge:detected',
  'optimization:completed',
  'allocation:updated',
  'alert:created',
];

/**
 * The bridge activates only when the deployment declares a Socket.IO endpoint
 * (VITE_SOCKET_URL). Without it — the frontend-only demo — the bridge stays
 * dormant instead of hammering an endpoint that does not exist, so the console
 * stays clean.
 */
const SOCKET_URL = (import.meta && import.meta.env && import.meta.env.VITE_SOCKET_URL) || null;

export const SOCKET_ENABLED = Boolean(SOCKET_URL);

let socket = null;
let status = 'idle'; // idle | connecting | connected | offline
const listeners = new Set();
const stateListeners = new Set();

function publishStatus(next) {
  status = next;
  stateListeners.forEach((listener) => {
    try {
      listener(next);
    } catch {
      /* a failing listener must not break the bridge */
    }
  });
}

export function getSocketStatus() {
  return status;
}

/** Subscribe to connection status (used by the live data hook). */
export function onSocketStatus(listener) {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/**
 * Register a handler for operational events. Returns an unsubscribe function,
 * so React effects can clean up properly.
 */
export function onOperationalEvent(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

function dispatchEvent(type, payload) {
  listeners.forEach((listener) => {
    try {
      listener(type, payload);
    } catch {
      /* ignore listener errors */
    }
  });
}

import { getToken } from './api';

/**
 * Connect the shared socket. Safe to call repeatedly — the demo has no
 * backend, so failures are swallowed and reported as `offline`.
 */
export function connectSocket({ token } = {}) {
  if (!SOCKET_URL) {
    if (status !== 'offline') publishStatus('offline');
    return null;
  }
  const authToken = token || getToken();
  if (socket) {
    if (authToken && socket.auth?.token !== authToken) {
      disconnectSocket();
    } else {
      return socket;
    }
  }
  try {
    publishStatus('connecting');
    socket = io(SOCKET_URL, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      auth: authToken ? { token: authToken } : undefined,
      reconnectionAttempts: 5,
      timeout: 5000,
      autoConnect: true,
    });

    socket.on('connect', () => publishStatus('connected'));
    socket.on('disconnect', () => publishStatus('offline'));
    socket.on('connect_error', () => publishStatus('offline'));

    OPERATIONAL_EVENTS.forEach((event) => {
      socket.on(event, (payload) => dispatchEvent(event, payload));
    });
  } catch {
    publishStatus('offline');
    socket = null;
  }
  return socket;
}

export function disconnectSocket() {
  if (!socket) return;
  try {
    socket.removeAllListeners();
    socket.close();
  } catch {
    /* ignore */
  }
  socket = null;
  publishStatus('idle');
}
