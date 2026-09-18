/**
 * Operational error type. Anything thrown as an ApiError is safe to return to
 * staff (no stack traces, no database detail) — see middleware/errorHandler.
 */
class ApiError extends Error {
  constructor({ status = 500, code = 'INTERNAL_ERROR', message = 'Unexpected server error.', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }

  static badRequest(message = 'Invalid request.', details) {
    return new ApiError({ status: 400, code: 'VALIDATION_ERROR', message, details });
  }

  static unauthorized(message = 'Sign-in required.') {
    return new ApiError({ status: 401, code: 'UNAUTHORIZED', message });
  }

  static forbidden(message = 'This action is not permitted for your role.') {
    return new ApiError({ status: 403, code: 'FORBIDDEN', message });
  }

  static notFound(message = 'Resource not found.') {
    return new ApiError({ status: 404, code: 'NOT_FOUND', message });
  }

  static conflict(message = 'The resource is no longer available.', details) {
    return new ApiError({ status: 409, code: 'RESOURCE_CONFLICT', message, details });
  }

  static unprocessable(message = 'The request could not be applied.', details) {
    return new ApiError({ status: 422, code: 'UNPROCESSABLE', message, details });
  }

  static serviceUnavailable(message = 'A required service is not available.') {
    return new ApiError({ status: 503, code: 'SERVICE_UNAVAILABLE', message });
  }
}

module.exports = { ApiError };
