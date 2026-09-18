/**
 * HTTP + realtime entry point.
 *
 * Starts the API, attaches Socket.IO to the same server, verifies the database
 * connection and shuts down cleanly on a signal.
 */

const http = require('http');
const app = require('./app');
const env = require('./config/env');
const logger = require('./utils/logger');
const { checkDatabase, disconnect } = require('./config/database');
const { createSocketServer } = require('./socket');
const { OPERATIONAL_EVENTS } = require('./socket/bus');

async function start() {
  const database = await checkDatabase();
  if (!database.ok) {
    logger.error(`database unavailable — ${database.error || database.status}`);
    logger.warn('start PostgreSQL (sudo pg_ctlcluster 17 main start) and run `npm run seed` before starting the API');
  } else {
    logger.info(`database ready — ${database.latencyMs} ms round trip`);
  }

  const server = http.createServer(app);
  createSocketServer(server);

  server.listen(env.port, '0.0.0.0', () => {
    logger.info(`MediCore API listening on http://0.0.0.0:${env.port}/api (${env.nodeEnv})`);
    logger.info(`allowed frontend origins: ${env.corsOrigins.join(', ')}`);
    logger.info(`operational events: ${OPERATIONAL_EVENTS.join(', ')}`);
  });

  const shutdown = async (signal) => {
    logger.info(`${signal} received — shutting down`);
    server.close(async () => {
      await disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };

  ['SIGINT', 'SIGTERM'].forEach((signal) => process.on(signal, () => shutdown(signal)));

  process.on('unhandledRejection', (reason) => logger.error(`unhandled rejection: ${reason}`));
  process.on('uncaughtException', (error) => {
    logger.error(`uncaught exception: ${error.message}`, error.stack);
  });

  return server;
}

if (require.main === module) start();

module.exports = { start };
