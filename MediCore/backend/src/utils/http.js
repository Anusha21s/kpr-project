/**
 * Response helpers.
 *
 * The frontend consumes bare payloads for most endpoints, so successful reads
 * return the payload directly. Mutations additionally carry `success: true` and
 * an `error` envelope is always `{ success: false, error: { code, message } }`.
 */
const ok = (res, data, status = 200) => res.status(status).json(data);

const created = (res, data) => res.status(201).json({ success: true, data });

const mutation = (res, data, status = 200) => res.status(status).json({ success: true, data });

module.exports = { ok, created, mutation };
