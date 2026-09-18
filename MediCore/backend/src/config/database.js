/**
 * Prisma client singleton.
 *
 * In development every nodemon restart re-uses the same client instance, which
 * avoids exhausting PostgreSQL connections.
 */
const { PrismaClient } = require('@prisma/client');
const env = require('./env');

const globalForPrisma = globalThis;

const prisma =
  globalForPrisma.__medicorePrisma ||
  new PrismaClient({
    log: env.isProduction ? ['error'] : ['warn', 'error'],
  });

if (!env.isProduction) globalForPrisma.__medicorePrisma = prisma;

/**
 * Health probe used by GET /api/health and by the boot sequence.
 * @returns {{ok: boolean, status: string, latencyMs?: number, error?: string}}
 */
async function checkDatabase() {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, status: 'connected', latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      status: 'unavailable',
      error: env.isProduction ? 'database connection failed' : error.message.split('\n')[0],
    };
  }
}

async function disconnect() {
  await prisma.$disconnect();
}

module.exports = { prisma, checkDatabase, disconnect };
