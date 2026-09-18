/**
 * Arrival service.
 *
 * Owns the arrival flow: one row per registration at the emergency door, with
 * the arrival time and triage recorded. MediCore's demand models need a flow
 * (how many patients arrived in the last hour), which a waiting list alone
 * cannot answer, so this table is what the rolling arrival counts are read from.
 *
 * The counts here are the ones the dashboards and the models consume, and they
 * are computed from the rows — never hardcoded.
 */

const { prisma } = require('../config/database');

const WINDOWS = [
  ['last15m', 15],
  ['last30m', 30],
  ['last1h', 60],
  ['last3h', 3 * 60],
  ['last6h', 6 * 60],
  ['last24h', 24 * 60],
];

/**
 * Records one arrival.
 * Called by every registration path (REST intake, surge intake) so the flow is
 * complete no matter how the patient entered the hospital.
 */
async function record({ patientId = null, patientNumber = null, source = 'AMBULANCE', priority = 'Medium', department = 'Emergency', triage = 'ESI 3', arrivedAt = new Date(), recordedById = null }, client = prisma) {
  return client.arrivalLog.create({
    data: { patientId, patientNumber, source, priority, department, triage, arrivedAt, recordedById },
  });
}

/** Rolling arrival counts, computed from ArrivalLog. */
async function counts(client = prisma) {
  const now = Date.now();
  const oldest = new Date(now - 24 * 60 * 60 * 1000);
  const rows = await client.arrivalLog.findMany({
    where: { arrivedAt: { gte: oldest } },
    select: { arrivedAt: true, priority: true, source: true },
  });

  const windows = {};
  for (const [label, minutes] of WINDOWS) {
    const since = now - minutes * 60 * 1000;
    windows[label] = rows.filter((row) => row.arrivedAt.getTime() >= since).length;
  }
  const byPriority = rows.reduce((totals, row) => {
    totals[row.priority] = (totals[row.priority] || 0) + 1;
    return totals;
  }, {});
  const bySource = rows.reduce((totals, row) => {
    totals[row.source] = (totals[row.source] || 0) + 1;
    return totals;
  }, {});

  return {
    ...windows,
    arrivalsPerHour: windows.last1h,
    averagePerHour24h: Math.round((rows.length / 24) * 10) / 10,
    recorded24h: rows.length,
    byPriority,
    bySource,
    windowStart: new Date(oldest).toISOString(),
    generatedAt: new Date().toISOString(),
  };
}

/** Arrival series for the last N hours, one bucket per hour (oldest first). */
async function hourlySeries({ hours = 24 } = {}, client = prisma) {
  const now = new Date();
  const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const rows = await client.arrivalLog.findMany({
    where: { arrivedAt: { gte: start } },
    select: { arrivedAt: true },
  });

  const buckets = Array.from({ length: hours }, (_, index) => {
    const bucketStart = new Date(start.getTime() + index * 60 * 60 * 1000);
    return { hourStart: bucketStart.toISOString(), arrivals: 0 };
  });

  for (const row of rows) {
    const index = Math.min(hours - 1, Math.floor((row.arrivedAt.getTime() - start.getTime()) / (60 * 60 * 1000)));
    if (index >= 0) buckets[index].arrivals += 1;
  }
  return buckets;
}

module.exports = { record, counts, hourlySeries, WINDOWS };
