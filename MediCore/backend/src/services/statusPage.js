/**
 * Live status page for the MediCore API.
 *
 * Served at `GET /`. Every number on it is read from PostgreSQL at request
 * time — nothing is hardcoded and nothing is mocked. It exists so that opening
 * the backend in a browser shows the real operational state of the seeded
 * hospital rather than a JSON blob.
 *
 * The page is intentionally self-contained (inline styles, no external fonts,
 * scripts or images) so it renders anywhere, including inside a sandboxed
 * preview frame with no network access.
 */

const { prisma } = require('../config/database');
const env = require('../config/env');

const PALETTE = {
  background: '#f4f7f9',
  card: '#ffffff',
  ink: '#26323a',
  muted: '#6b7b88',
  line: '#e3eaef',
  teal: '#0f8b8d',
  blue: '#2f6f9f',
  amber: '#b4761f',
  red: '#b3453a',
  green: '#2f7d63',
};

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const bandColour = (value) => {
  if (value >= 95) return PALETTE.red;
  if (value >= 85) return PALETTE.amber;
  if (value >= 70) return PALETTE.blue;
  return PALETTE.green;
};

const bandLabel = (value) => {
  if (value >= 95) return 'CRITICAL';
  if (value >= 85) return 'HIGH';
  if (value >= 70) return 'MODERATE';
  return 'NORMAL';
};

async function collectSnapshot() {
  const [
    beds,
    icuBeds,
    queueWaiting,
    queueCritical,
    doctorsOnDuty,
    doctorsTotal,
    nursesOnDuty,
    nursesTotal,
    equipmentUnits,
    theatres,
    alerts,
    patients,
    pendingApprovals,
    activeSurge,
    auditEntries,
  ] = await Promise.all([
    prisma.bed.findMany({ select: { status: true, wardId: true } }),
    prisma.bed.findMany({ where: { wardId: 'icu' }, select: { status: true } }),
    prisma.patientQueue.count({ where: { status: 'WAITING' } }),
    prisma.patient.count({ where: { priority: 'Critical', status: { not: 'Discharged' } } }),
    prisma.doctor.count({ where: { dutyStatus: 'ON_DUTY' } }),
    prisma.doctor.count(),
    prisma.nurse.count({ where: { dutyStatus: 'ON_DUTY' } }),
    prisma.nurse.count(),
    prisma.equipmentUnit.findMany({ select: { status: true, reserved: true } }),
    prisma.operatingTheatre.findMany({ select: { id: true, status: true } }),
    prisma.alert.findMany({ select: { severity: true, status: true } }),
    prisma.patient.count(),
    prisma.approval.count({ where: { status: 'PENDING_REVIEW' } }),
    prisma.surgeSimulation.findFirst({ where: { active: true }, orderBy: { createdAt: 'desc' }, select: { reference: true, patientCount: true } }),
    prisma.auditLog.count(),
  ]);

  const occupied = beds.filter((bed) => bed.status === 'OCCUPIED').length;
  const available = beds.filter((bed) => bed.status === 'AVAILABLE').length;
  const cleaning = beds.filter((bed) => bed.status === 'CLEANING').length;
  const icuOccupied = icuBeds.filter((bed) => bed.status === 'OCCUPIED').length;
  const equipmentInUse = equipmentUnits.filter((unit) => unit.status === 'In Use').length;
  const equipmentAvailable = equipmentUnits.filter((unit) => unit.status === 'Available').length;

  const occupancy = beds.length ? (100 * occupied) / beds.length : 0;
  const icuOccupancy = icuBeds.length ? (100 * icuOccupied) / icuBeds.length : 0;

  return {
    beds: { total: beds.length, occupied, available, cleaning },
    icu: { total: icuBeds.length, occupied: icuOccupied, occupancy: icuOccupancy },
    occupancy,
    queue: { waiting: queueWaiting, critical: queueCritical },
    doctors: { onDuty: doctorsOnDuty, total: doctorsTotal },
    nurses: { onDuty: nursesOnDuty, total: nursesTotal },
    equipment: { total: equipmentUnits.length, inUse: equipmentInUse, available: equipmentAvailable },
    theatres,
    alerts: {
      total: alerts.length,
      open: alerts.filter((alert) => alert.status !== 'RESOLVED').length,
      critical: alerts.filter((alert) => alert.severity === 'CRITICAL' && alert.status !== 'RESOLVED').length,
    },
    patients,
    pendingApprovals,
    activeSurge,
    auditEntries,
  };
}

function statCard({ label, value, detail, accent }) {
  return `
    <div style="background:${PALETTE.card};border:1px solid ${PALETTE.line};border-radius:12px;padding:14px 16px;box-shadow:0 2px 10px rgba(38,50,56,0.06);">
      <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${PALETTE.muted};">${escapeHtml(label)}</div>
      <div style="font-size:26px;font-weight:600;color:${accent || PALETTE.ink};margin-top:6px;line-height:1.1;">${escapeHtml(value)}</div>
      ${detail ? `<div style="font-size:12px;color:${PALETTE.muted};margin-top:6px;">${escapeHtml(detail)}</div>` : ''}
    </div>`;
}

function meter(label, value, capacityText) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  const colour = bandColour(percent);
  return `
    <div style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;font-size:13px;color:${PALETTE.ink};margin-bottom:6px;">
        <span>${escapeHtml(label)}</span>
        <span style="color:${colour};font-weight:600;">${percent.toFixed(1)}% · ${bandLabel(percent)}</span>
      </div>
      <div style="height:8px;background:${PALETTE.line};border-radius:6px;overflow:hidden;">
        <div style="height:100%;width:${percent}%;background:${colour};border-radius:6px;"></div>
      </div>
      ${capacityText ? `<div style="font-size:12px;color:${PALETTE.muted};margin-top:6px;">${escapeHtml(capacityText)}</div>` : ''}
    </div>`;
}

function render(snapshot) {
  const { beds, icu, queue, doctors, nurses, equipment, theatres, alerts, pendingApprovals } = snapshot;

  const endpoints = [
    ['POST', '/api/auth/login', 'sign in — role comes from the account, never chosen by the user'],
    ['GET', '/api/auth/me', 'the signed-in identity, staff reference and permissions'],
    ['GET', '/api/dashboard/overview', 'one aggregated payload feeding all three dashboards'],
    ['GET', '/api/patients', 'hospital patient list (doctors and nurses are scoped to their own patients server-side)'],
    ['GET', '/api/patients/my', 'the signed-in clinician’s own patients only'],
    ['GET', '/api/queue', 'emergency queue in clinical priority, then waiting time order'],
    ['GET', '/api/beds', 'bed board with ward, status and occupancy'],
    ['GET', '/api/doctors', 'roster with duty status, availability and current load'],
    ['GET', '/api/nurses', 'nursing roster with ward assignment and workload limits'],
    ['GET', '/api/equipment', 'equipment register with per-unit availability'],
    ['GET', '/api/emergency-resources', 'emergency bays, resus, trauma and ambulance status'],
    ['GET', '/api/ot', 'theatre schedule and surgical backlog'],
    ['POST', '/api/simulation', 'surge simulation — projected state, live data untouched'],
    ['POST', '/api/optimization', 'multi-resource optimization across beds, ICU, staff, equipment and theatres'],
    ['POST', '/api/allocations/:id/approve', 'coordinator approval — single transaction with row locking'],
    ['GET', '/api/alerts', 'operational alerts (CRITICAL / HIGH / OPERATIONAL / INFO)'],
    ['GET', '/api/notifications', 'persisted per-user notifications that survive being offline'],
    ['GET', '/api/health', 'service, database and socket health'],
  ];

  const rows = endpoints
    .map(
      ([method, path, description]) => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid ${PALETTE.line};white-space:nowrap;">
          <span style="display:inline-block;min-width:52px;text-align:center;font-size:11px;font-weight:600;letter-spacing:.04em;padding:3px 6px;border-radius:6px;background:${method === 'GET' ? '#eef4f8' : '#eaf4f1'};color:${method === 'GET' ? PALETTE.blue : PALETTE.green};">${method}</span>
        </td>
        <td style="padding:8px 10px;border-bottom:1px solid ${PALETTE.line};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;color:${PALETTE.ink};">${escapeHtml(path)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid ${PALETTE.line};font-size:12.5px;color:${PALETTE.muted};">${escapeHtml(description)}</td>
      </tr>`,
    )
    .join('');

  const theatreRows = theatres
    .map(
      (theatre) => `
      <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0;border-bottom:1px solid ${PALETTE.line};">
        <span style="color:${PALETTE.ink};">${escapeHtml(theatre.id)}</span>
        <span style="color:${PALETTE.muted};">${escapeHtml(theatre.status)}</span>
      </div>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MediCore API · live hospital state</title>
</head>
<body style="margin:0;background:${PALETTE.background};color:${PALETTE.ink};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:1080px;margin:0 auto;padding:28px 20px 48px;">

    <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:12px;justify-content:space-between;margin-bottom:6px;">
      <h1 style="font-size:22px;margin:0;letter-spacing:-.01em;">MediCore API · live hospital state</h1>
      <span style="font-size:12px;color:${PALETTE.muted};">${escapeHtml(env.nodeEnv)} · port ${escapeHtml(env.port)} · PostgreSQL</span>
    </div>
    <p style="margin:0 0 22px;font-size:13.5px;color:${PALETTE.muted};max-width:70ch;">
      Every figure below is read from the database at request time. This page is the backend service itself —
      the React dashboards consume the same data through the endpoints listed underneath.
    </p>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:22px;">
      ${statCard({
        label: 'Bed occupancy',
        value: `${snapshot.occupancy.toFixed(1)}%`,
        detail: `${beds.occupied} occupied · ${beds.available} available · ${beds.cleaning} in cleaning`,
        accent: bandColour(snapshot.occupancy),
      })}
      ${statCard({
        label: 'Emergency queue',
        value: queue.waiting,
        detail: `${queue.critical} critical or high-priority patients in the hospital`,
        accent: queue.waiting >= 18 ? PALETTE.amber : PALETTE.ink,
      })}
      ${statCard({
        label: 'Doctors on duty',
        value: `${doctors.onDuty}/${doctors.total}`,
        detail: 'OFF_DUTY, LEAVE and UNAVAILABLE staff are excluded from allocation',
      })}
      ${statCard({
        label: 'Nurses on duty',
        value: `${nurses.onDuty}/${nurses.total}`,
        detail: 'configured workload limits are enforced during allocation',
      })}
      ${statCard({
        label: 'Open alerts',
        value: alerts.open,
        detail: `${alerts.critical} of them CRITICAL · ${alerts.total} raised in total`,
        accent: alerts.critical ? PALETTE.red : PALETTE.ink,
      })}
      ${statCard({
        label: 'Awaiting approval',
        value: pendingApprovals,
        detail: 'recommendations applied only after a coordinator confirms',
        accent: pendingApprovals ? PALETTE.amber : PALETTE.ink,
      })}
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-bottom:22px;">
      <div style="background:${PALETTE.card};border:1px solid ${PALETTE.line};border-radius:14px;padding:18px;box-shadow:0 2px 10px rgba(38,50,56,0.06);">
        <h2 style="font-size:14px;margin:0 0 14px;letter-spacing:.02em;">Capacity</h2>
        ${meter('General bed occupancy', snapshot.occupancy, `${beds.total} configured beds`)}
        ${meter('ICU occupancy', icu.occupancy, `${icu.occupied} of ${icu.total} ICU beds in use`)}
        ${meter(
          'Equipment utilisation',
          equipment.total ? (100 * equipment.inUse) / equipment.total : 0,
          `${equipment.inUse} in use · ${equipment.available} available of ${equipment.total} unit(s)`,
        )}
        ${meter(
          'Theatre load',
          theatres.length ? (100 * theatres.filter((t) => t.status !== 'AVAILABLE').length) / theatres.length : 0,
          `${theatres.filter((t) => t.status === 'AVAILABLE').length} of ${theatres.length} theatres free`,
        )}
      </div>

      <div style="background:${PALETTE.card};border:1px solid ${PALETTE.line};border-radius:14px;padding:18px;box-shadow:0 2px 10px rgba(38,50,56,0.06);">
        <h2 style="font-size:14px;margin:0 0 14px;letter-spacing:.02em;">Theatre status &amp; activity</h2>
        ${theatreRows || `<div style="font-size:13px;color:${PALETTE.muted};">No theatres configured.</div>`}
        <div style="margin-top:14px;font-size:12.5px;color:${PALETTE.muted};line-height:1.7;">
          <div>Patients in the system: <strong style="color:${PALETTE.ink};">${escapeHtml(snapshot.patients)}</strong></div>
          <div>Audit entries recorded: <strong style="color:${PALETTE.ink};">${escapeHtml(snapshot.auditEntries)}</strong></div>
          <div>Active surge simulation: <strong style="color:${PALETTE.ink};">${
            snapshot.activeSurge ? escapeHtml(snapshot.activeSurge.reference) : 'none'
          }</strong></div>
        </div>
      </div>
    </div>

    <div style="background:${PALETTE.card};border:1px solid ${PALETTE.line};border-radius:14px;padding:18px;box-shadow:0 2px 10px rgba(38,50,56,0.06);margin-bottom:22px;">
      <h2 style="font-size:14px;margin:0 0 12px;letter-spacing:.02em;">Demo accounts</h2>
      <div style="font-size:13px;color:${PALETTE.muted};line-height:1.9;">
        All accounts use the password <code style="background:#f1f5f8;padding:2px 6px;border-radius:5px;color:${PALETTE.ink};">demo123</code>.
        The role is read from the account — it is never selected on the login screen.
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-top:12px;font-size:13px;">
        ${[
          ['CMD001', 'Command Center'],
          ['RES001', 'Resource Coordinator'],
          ['DOC001', 'Doctor — Dr. Kumar, Cardiology'],
          ['NUR001', 'Nurse — Nurse Priya, ICU'],
        ]
          .map(
            ([id, role]) => `
          <div style="border:1px solid ${PALETTE.line};border-radius:10px;padding:10px 12px;">
            <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;color:${PALETTE.ink};">${escapeHtml(id)}</div>
            <div style="font-size:12px;color:${PALETTE.muted};margin-top:4px;">${escapeHtml(role)}</div>
          </div>`,
          )
          .join('')}
      </div>
    </div>

    <div style="background:${PALETTE.card};border:1px solid ${PALETTE.line};border-radius:14px;padding:18px;box-shadow:0 2px 10px rgba(38,50,56,0.06);">
      <h2 style="font-size:14px;margin:0 0 8px;letter-spacing:.02em;">API surface</h2>
      <table style="width:100%;border-collapse:collapse;">
        <tbody>${rows}</tbody>
      </table>
      <p style="font-size:12px;color:${PALETTE.muted};margin:14px 0 0;line-height:1.7;">
        Operational decision support only. Recommendations are proposed for review and applied only after an
        authorised staff member approves them; nothing in this service diagnoses or treats a patient.
      </p>
    </div>

    <p style="font-size:12px;color:${PALETTE.muted};margin-top:18px;">
      Generated ${escapeHtml(new Date().toISOString())} · <a href="/api/health" style="color:${PALETTE.blue};text-decoration:none;">/api/health</a>
    </p>
  </div>
</body>
</html>`;
}

/** Render the live status page, degrading to a minimal message if the DB is down. */
async function statusPage() {
  try {
    return render(await collectSnapshot());
  } catch (error) {
    return `<!doctype html><html><body style="font-family:sans-serif;padding:32px;color:${PALETTE.ink};background:${PALETTE.background};">
      <h1 style="font-size:18px;">MediCore API</h1>
      <p style="color:${PALETTE.muted};">The service is running but the operational database could not be read: ${escapeHtml(error.message)}</p>
      <p><a href="/api/health" style="color:${PALETTE.blue};">/api/health</a></p>
    </body></html>`;
  }
}

module.exports = { statusPage, collectSnapshot };
