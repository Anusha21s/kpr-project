/**
 * Socket.IO layer (§34, §46).
 *
 * · The handshake token is verified with the same JWT secret as the REST API.
 * · Every socket joins its own user room, its role room and its department room.
 * · Events are published through the bus, so only the rooms that may see the
 *   payload receive it — another doctor's patient detail is never broadcast.
 *
 * Emitted events (the complete list):
 *   bed:updated · doctor:availability · nurse:availability · equipment:updated
 *   queue:updated · surge:detected · optimization:completed · allocation:updated
 *   alert:created
 */

const { Server } = require('socket.io');
const env = require('../config/env');
const logger = require('../utils/logger');
const { prisma } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { setIO, room, EVENTS, OPERATIONAL_EVENTS } = require('./bus');

function buildOrigins() {
  if (env.corsOrigins.includes('*')) return true;
  return env.corsOrigins;
}

/**
 * Attaches the realtime layer to the HTTP server.
 * @param {import('http').Server} httpServer
 */
function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: buildOrigins(),
      credentials: true,
      methods: ['GET', 'POST'],
    },
    path: '/socket.io',
    /* Polling first so the handshake survives proxies that do not upgrade. */
    transports: ['websocket', 'polling'],
  });

  /* ------------------------------------------------------ authentication */
  io.use(async (socket, next) => {
    const token =
      (socket.handshake.auth && socket.handshake.auth.token) ||
      (socket.handshake.query && socket.handshake.query.token) ||
      null;
    if (!token) return next(new Error('UNAUTHORIZED'));

    const payload = verifyToken(token);
    if (!payload) return next(new Error('UNAUTHORIZED'));

    try {
      const user = await prisma.user.findUnique({ where: { id: payload.sub }, include: { role: true } });
      if (!user || !user.isActive) return next(new Error('UNAUTHORIZED'));
      socket.data.user = {
        id: user.id,
        role: user.roleCode,
        staffRef: user.staffRef || user.staffId,
        name: user.name,
        department: user.department,
      };
      return next();
    } catch (error) {
      logger.error(`socket auth failed: ${error.message}`);
      return next(new Error('UNAUTHORIZED'));
    }
  });

  /* ------------------------------------------------------------ rooms */
  io.on('connection', (socket) => {
    const { id, role, department, staffRef, name } = socket.data.user;
    socket.join(room.user(id));
    socket.join(room.role(role));
    if (department) socket.join(room.department(department));

    socket.emit('connection:ready', {
      socketId: socket.id,
      rooms: [room.user(id), room.role(role), department ? room.department(department) : null].filter(Boolean),
      role,
      staffRef,
      events: OPERATIONAL_EVENTS,
      connectedAt: new Date().toISOString(),
    });

    logger.info(`socket connected — ${name} (${role}) ${socket.id}`);

    socket.on('error', (error) => logger.warn(`socket error for ${staffRef}: ${error.message}`));
    socket.on('disconnect', (reason) => logger.info(`socket disconnected — ${name} (${reason})`));
  });

  setIO(io);
  logger.info(`socket server ready — ${OPERATIONAL_EVENTS.length} operational events, rooms user:* / role:* / department:*`);
  return io;
}

module.exports = { createSocketServer, EVENTS, room };
