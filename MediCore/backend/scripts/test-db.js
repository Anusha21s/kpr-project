#!/usr/bin/env node
/**
 * Prepares the isolated test database.
 *
 * The test suite never touches the development database: this script creates
 * `medicore_test` (if missing), resets it, applies the migrations and runs the
 * seed, so every run starts from the same believable hospital state.
 *
 * Usage: node scripts/test-db.js
 */

const { execSync } = require('node:child_process');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { PrismaClient } = require('@prisma/client');

const BASE_URL = process.env.DATABASE_URL;
if (!BASE_URL) {
  console.error('DATABASE_URL is not set — copy .env.example to .env first.');
  process.exit(1);
}

const TEST_DB = process.env.TEST_DATABASE_NAME || 'medicore_test';
const testUrl = process.env.TEST_DATABASE_URL || BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);
const adminUrl = BASE_URL.replace(/\/[^/?]+(\?|$)/, '/postgres$1');

async function ensureDatabase() {
  const client = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  try {
    await client.$executeRawUnsafe(`CREATE DATABASE "${TEST_DB}"`);
    console.log(`created test database ${TEST_DB}`);
  } catch (error) {
    if (String(error.message).includes('already exists')) {
      console.log(`test database ${TEST_DB} already exists`);
    } else {
      throw error;
    }
  } finally {
    await client.$disconnect();
  }
}

function run(command, env) {
  const root = path.join(__dirname, '..');
  execSync(command, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
}

(async () => {
  await ensureDatabase();
  const env = { DATABASE_URL: testUrl, NODE_ENV: 'test', LOG_LEVEL: 'error' };
  run('npx prisma migrate reset --force --skip-seed', env);
  run('node prisma/seed.js', env);
  console.log(`\ntest database ready → ${testUrl.replace(/:[^:@/]+@/, ':****@')}`);
})();
