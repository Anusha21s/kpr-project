import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * MediCore frontend — Vite + React (JavaScript only).
 *
 * The frontend talks to the Node backend at `VITE_API_BASE_URL` /
 * `VITE_SOCKET_URL`. Two deployments are supported:
 *
 *   1. Direct — the env vars point at the backend
 *      (`http://localhost:4000/api`, `http://localhost:4000`).
 *   2. Same-origin — the env vars are relative (`/api`, `/`) and this dev
 *      server proxies `/api` and `/socket.io` to the backend. This is what the
 *      hosted preview uses, because the browser there cannot reach the
 *      container's own `localhost`.
 *
 * In both cases the browser only ever talks to one origin.
 */

const BACKEND = process.env.MEDICORE_BACKEND_URL || 'http://127.0.0.1:4000';

/** Strip the configured base down to the origin the proxy forwards to. */
const targetFor = (configured) => {
  if (!configured) return BACKEND;
  try {
    const url = new URL(configured);
    return `${url.protocol}//${url.host}`;
  } catch {
    return BACKEND;
  }
};

const configuredBase = process.env.VITE_API_BASE_URL || '';
const proxyTarget = targetFor(configuredBase);

/** Keep the backend's origin allow-list meaningful while proxying. */
const withOrigin = (proxy) => {
  proxy.on('proxyReq', (proxyReq) => {
    proxyReq.setHeader('origin', 'http://localhost:5173');
  });
  proxy.on('proxyReqWs', (proxyReq) => {
    proxyReq.setHeader('origin', 'http://localhost:5173');
  });
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // Hosted preview runs behind a proxy domain, so allow all hosts/origins.
    allowedHosts: true,
    cors: true,
    proxy: {
      '/api': { target: proxyTarget, changeOrigin: true, secure: false, configure: withOrigin },
      '/socket.io': { target: proxyTarget, changeOrigin: true, ws: true, secure: false, configure: withOrigin },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
});
