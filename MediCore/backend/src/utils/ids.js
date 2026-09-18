/** Deterministic-enough reference generators for operational records. */
const pad = (value, size = 2) => String(value).padStart(size, '0');

const counter = new Map();

function nextSequence(key) {
  const current = counter.get(key) || 0;
  const next = current + 1;
  counter.set(key, next);
  return next;
}

const reference = (prefix, sequence) => `${prefix}-${pad(sequence, 4)}`;

const allocationReference = (date = new Date()) =>
  `ALL-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`;

const approvalReference = (date = new Date()) =>
  `APR-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

const optimizationReference = (date = new Date()) =>
  `OPT-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

const simulationReference = (date = new Date()) =>
  `SIM-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

/**
 * Collision-resistant reference for records created during operations
 * (alerts, approvals, allocations, simulation runs).
 * Example: ALR-K3F9QZ2
 */
const randomRef = (prefix, { entropy = 5 } = {}) => {
  const time = Date.now().toString(36).toUpperCase().slice(-3);
  const random = Math.random().toString(36).toUpperCase().slice(2, 2 + entropy);
  return `${prefix}-${time}${random}`;
};

module.exports = {
  nextSequence,
  reference,
  randomRef,
  allocationReference,
  approvalReference,
  optimizationReference,
  simulationReference,
};
