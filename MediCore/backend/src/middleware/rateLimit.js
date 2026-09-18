/**
 * Rate limiting.
 *
 * The credential endpoint is throttled so a password cannot be brute-forced.
 * The window is deliberately generous enough for the hospital's own shift
 * change: dozens of clinicians signing in around the same minute is normal
 * behaviour, not an attack.
 *
 * Development and test runs (the demo rehearsal, the contract sweep and the
 * automated tests sign in repeatedly) use a wider window so they are not
 * throttled by their own traffic. Production keeps the strict limit.
 */

const rateLimit = require('express-rate-limit');

const env = require('../config/env');

const isDevelopment = env.nodeEnv !== 'production';
const WINDOW_MS = 5 * 60 * 1000;

const loginLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: isDevelopment ? 500 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many sign-in attempts. Try again in a few minutes.' },
  },
});

module.exports = { loginLimiter, LOGIN_LIMIT: isDevelopment ? 500 : 30, LOGIN_WINDOW_MS: WINDOW_MS };
