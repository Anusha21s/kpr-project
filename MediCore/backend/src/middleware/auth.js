/**
 * JWT authentication.
 *
 * The token carries `sub` (user id), `role` and `staffRef`. The role always
 * comes from the account — never from a request body (§6).
 */
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { prisma } = require('../config/database');
const { ApiError } = require('../utils/ApiError');

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.roleCode, staffRef: user.staffRef || user.staffId, staffId: user.staffId, name: user.name },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn },
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, env.jwtSecret);
  } catch (error) {
    return null;
  }
}

const bearer = (req) => {
  const header = req.headers.authorization || '';
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  return header.slice(7).trim();
};

/** Loads the authenticated user (with role permissions) onto req.user. */
async function authenticate(req, res, next) {
  const token = bearer(req);
  if (!token) return next(ApiError.unauthorized('Sign-in required.'));

  const payload = verifyToken(token);
  if (!payload) return next(ApiError.unauthorized('Your session has expired. Sign in again.'));

  try {
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, include: { role: true } });
    if (!user || !user.isActive) return next(ApiError.unauthorized('This account is not active.'));

    req.user = user;
    req.auth = {
      userId: user.id,
      /* staffId  = the account's login id (CMD001, DOC001 …)
         staffRef = the clinical roster reference (DOC-1042, NUR-201 …) and is
                    what patient/staff assignment rows reference. */
      staffId: user.staffId,
      staffRef: user.staffRef || user.staffId,
      staffRowId: user.staffRef || user.staffId,
      name: user.name,
      department: user.department,
      role: user.roleCode,
      permissions: Array.isArray(user.role.permissions) ? user.role.permissions : [],
    };
    return next();
  } catch (error) {
    return next(error);
  }
}

/** Attaches the user when a token is present, but never blocks the request. */
async function optionalAuthenticate(req, res, next) {
  if (!bearer(req)) return next();
  return authenticate(req, res, (error) => next(error && error.status === 401 ? undefined : error));
}

module.exports = { authenticate, optionalAuthenticate, signToken, verifyToken };
