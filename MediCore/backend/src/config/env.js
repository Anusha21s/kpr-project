/** Environment configuration — one place that reads process.env. */
require('dotenv').config();

const list = (value, fallback) =>
  String(value || fallback)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET || 'medicore_development_secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',

  /* HE-02 AI service (Python). The Node backend calls it server-to-server;
     the React app never does. When it is unreachable, every AI-backed endpoint
     degrades to the deterministic operational logic instead of failing. */
  aiServiceEnabled: (process.env.AI_SERVICE_ENABLED || 'true') !== 'false',
  aiServiceUrl: process.env.AI_SERVICE_URL || 'http://127.0.0.1:5001',
  aiServiceTimeoutMs: Number(process.env.AI_SERVICE_TIMEOUT_MS || 8000),
  aiServiceAdvisoryTimeoutMs: Number(process.env.AI_SERVICE_ADVISORY_TIMEOUT_MS || 20000),
  frontendOrigins: list(process.env.FRONTEND_URL, 'http://localhost:5173,http://127.0.0.1:5173'),
  socketOrigins: list(process.env.SOCKET_CORS_ORIGIN, 'http://localhost:5173,http://127.0.0.1:5173'),
};

/* Every origin the API accepts: the web client plus the realtime client.
   Access-Control-Allow-Origin is always an explicit list — never '*'. */
env.corsOrigins = Array.from(new Set([...env.frontendOrigins, ...env.socketOrigins]));

env.isProduction = env.nodeEnv === 'production';
env.isTest = env.nodeEnv === 'test';

module.exports = env;
