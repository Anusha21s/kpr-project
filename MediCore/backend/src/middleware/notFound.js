const { ApiError } = require('../utils/ApiError');

module.exports = function notFound(req, res, next) {
  next(ApiError.notFound(`No endpoint matches ${req.method} ${req.originalUrl}.`));
};
