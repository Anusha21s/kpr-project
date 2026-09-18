/**
 * Role / permission authorization.
 *
 *   authorize('command_center')                     → role allow-list
 *   requirePermission('allocations:confirm')        → permission from the Role row
 */
const { ApiError } = require('../utils/ApiError');

const authorize =
  (...roles) =>
  (req, res, next) => {
    if (!req.auth) return next(ApiError.unauthorized());
    if (!roles.length || roles.includes(req.auth.role)) return next();
    return next(ApiError.forbidden('This area is not assigned to your role.'));
  };

const requirePermission =
  (...permissions) =>
  (req, res, next) => {
    if (!req.auth) return next(ApiError.unauthorized());
    const granted = req.auth.permissions || [];
    const allowed = permissions.some((permission) => granted.includes(permission));
    if (allowed) return next();
    return next(ApiError.forbidden('This action is not permitted for your role.'));
  };

/** Any of the listed roles may proceed; used where two roles share a read. */
const authorizeAny = authorize;

module.exports = { authorize, authorizeAny, requirePermission };
