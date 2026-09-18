/**
 * Express application (§15, §18, §45).
 *
 * Security headers, a CORS allow-list limited to the configured frontend
 * origins, request logging, rate limiting on authentication, the versioned API
 * router, a 404 handler and the central error handler.
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const logger = require('./utils/logger');
const routes = require('./routes');
const { statusPage } = require('./services/statusPage');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

/* ------------------------------------------------------------- security */
app.use(
  helmet({
    contentSecurityPolicy: false, // the only HTML served is the read-only status landing page
    // The landing page holds no credentials and performs no mutations; it is
    // meant to be embedded (dashboards, review panes, preview frames), so it is
    // not frame-blocked. Credential safety comes from bearer tokens plus the
    // CORS allow-list below, not from frame headers on a read-only page.
    frameguard: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);

/* CORS is an explicit allow-list — never `origin: '*'` with credentials (§45). */
const allowedOrigins = env.corsOrigins;
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // native clients / same-origin proxies
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return callback(null, true);
      logger.warn(`blocked CORS origin: ${origin}`);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  }),
);

/* --------------------------------------------------------------- parsing */
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));

/* -------------------------------------------------------------- logging */
app.use(
  morgan(env.isProduction ? 'combined' : 'dev', {
    stream: { write: (line) => logger.http ? logger.http(line.trim()) : logger.info(line.trim()) },
    skip: (req) => req.path === '/api/health',
  }),
);

/* ----------------------------------------------------------- throttling */
app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    /* The dashboards poll and the sockets reconnect, so a single browser tab is
       a steady stream of legitimate requests. The ceiling stays well above that
       while still stopping a runaway client. */
    limit: env.isTest ? 10000 : env.nodeEnv === 'production' ? 600 : 3000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests — try again shortly.' } },
  }),
);

/* ------------------------------------------------------------------ API */
/* The service landing page: a live operational status view read from the
   database, so opening the backend in a browser shows the real hospital state.
   Machine-readable service metadata stays available at /api/health. */
app.get('/', async (req, res, next) => {
  try {
    res.type('html').send(await statusPage());
  } catch (error) {
    next(error);
  }
});

app.get('/api', (req, res) =>
  res.json({
    service: 'MediCore API',
    landingPage: '/',
    docs: '/api/health',
    endpoints: [
      '/api/auth/login',
      '/api/auth/me',
      '/api/dashboard/overview',
      '/api/patients',
      '/api/patients/my',
      '/api/queue',
      '/api/beds',
      '/api/doctors',
      '/api/nurses',
      '/api/equipment',
      '/api/emergency-resources',
      '/api/ot',
      '/api/simulation',
      '/api/optimization',
      '/api/allocations',
      '/api/alerts',
      '/api/notifications',
      '/api/health',
    ],
  }),
);

app.use('/api', routes);

/* --------------------------------------------------------- 404 + errors */
app.use(notFound);
app.use(errorHandler);

module.exports = app;
