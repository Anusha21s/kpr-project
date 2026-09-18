/**
 * Shared test helpers.
 *
 * The environment is switched to the isolated test database *before* the app is
 * required, so the Prisma client and the config are bound to `medicore_test`.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  (process.env.DATABASE_URL || 'postgresql://medicore:medicore_dev_pw@127.0.0.1:5432/medicore').replace(
    /\/[^/?]+(\?|$)/,
    '/medicore_test$1',
  );
process.env.JWT_SECRET = process.env.JWT_SECRET || 'medicore_test_secret_only';

const http = require('node:http');
const supertest = require('supertest');
const app = require('../src/app');
const { prisma, disconnect } = require('../src/config/database');
const { createSocketServer } = require('../src/socket');

const PASSWORD = process.env.SEED_PASSWORD || 'demo123';

const request = () => supertest(app);

/** Signs in and returns `{token, user}`. */
async function login(staffId, password = PASSWORD) {
  const response = await supertest(app).post('/api/auth/login').send({ staffId, password });
  if (response.status !== 200) throw new Error(`login failed for ${staffId}: ${response.status} ${JSON.stringify(response.body)}`);
  return { token: response.body.token, user: response.body.user };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** A booted HTTP server with the realtime layer attached (ephemeral port). */
async function startRealtimeServer() {
  const server = http.createServer(app);
  const io = createSocketServer(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, io, url: `http://127.0.0.1:${server.address().port}` };
}

const stopRealtimeServer = async ({ server, io }) => {
  await new Promise((resolve) => io.close(resolve));
  await new Promise((resolve) => server.close(resolve));
};

/** Runs an action and waits for the matching socket event. */
function waitForEvent(socket, event, { timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeout);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

module.exports = { app, prisma, disconnect, request, login, auth, PASSWORD, startRealtimeServer, stopRealtimeServer, waitForEvent, http };
