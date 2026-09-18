/** Zod validation middleware. */
const { ApiError } = require('../utils/ApiError');

const validate =
  (schema, source = 'body') =>
  (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || source,
        message: issue.message,
      }));
      return next(ApiError.badRequest('The request could not be processed — check the submitted values.', details));
    }
    if (source === 'body') req.body = result.data;
    else if (source === 'query') req.validatedQuery = result.data;
    else req.validatedParams = result.data;
    return next();
  };

module.exports = { validate };
