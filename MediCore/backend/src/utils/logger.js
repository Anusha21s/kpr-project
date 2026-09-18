/** Small structured logger so every line carries a level and a timestamp. */
const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const configured = levels[process.env.LOG_LEVEL] ?? (process.env.NODE_ENV === 'production' ? 2 : 3);

const emit = (level, message, meta) => {
  if (levels[level] > configured) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase().padEnd(5)}] ${message}`;
  if (meta === undefined) {
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level](line);
    return;
  }
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](line, meta);
};

module.exports = {
  error: (message, meta) => emit('error', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  info: (message, meta) => emit('info', message, meta),
  debug: (message, meta) => emit('debug', message, meta),
};
