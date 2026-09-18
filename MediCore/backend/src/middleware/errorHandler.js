/**
 * Central error handler.
 *
 * ApiError instances carry a safe, human-readable message. Anything else is
 * logged with its stack and reported to staff as a generic failure — database
 * detail and stack traces never reach the client (§45).
 */
const env = require('../config/env');
const logger = require('../utils/logger');
const { ApiError } = require('../utils/ApiError');

// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(error, req, res, next) {
  const isApiError = error instanceof ApiError;
  const status = isApiError ? error.status : 500;

  if (!isApiError || status >= 500) {
    logger.error(`${req.method} ${req.originalUrl} → ${status}: ${error.message}`, env.isProduction ? undefined : error.stack);
  }

  const payload = {
    success: false,
    error: {
      code: isApiError ? error.code : 'INTERNAL_ERROR',
      message: isApiError ? error.message : 'Unable to complete the request. Try again, or contact the hospital IT desk.',
    },
  };
  if (isApiError && error.details) payload.error.details = error.details;
  if (!env.isProduction && !isApiError) payload.error.debug = error.message;

  res.status(status).json(payload);
};
