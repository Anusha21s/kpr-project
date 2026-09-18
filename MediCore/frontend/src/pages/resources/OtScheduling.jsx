import { useState } from 'react';
import { CalendarClock, Scissors, TriangleAlert } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import DataTable from '../../components/DataTable';
import StatusBadge from '../../components/StatusBadge';
import ConfirmationModal from '../../components/ConfirmationModal';
import DetailModal from '../../components/DetailModal';
import StatTile from '../../components/StatTile';
import { useHospital } from '../../hooks/useHospital';

/**
 * OT Scheduling (section 22) — theatre status, surgical backlog and the hold /
 * release actions a coordinator owns. Slots are never booked automatically.
 */
export default function OtScheduling() {
  const { state, metrics, actions } = useHospital();
  const [pending, setPending] = useState(null);
  const [selected, setSelected] = useState(null);

  const rooms = state.otRooms;
  const ongoingCount = rooms.filter((room) => room.status === 'Ongoing').length;
  const scheduledCount = rooms.filter((room) => room.status === 'Scheduled').length;
  const equipmentBlocked = rooms.filter((room) => room.status === 'Held' || (room.requiredEquipment || []).some((item) => state.equipment.some((unit) => unit.name === item && unit.inUse >= unit.total)));
  const blockedNames = Array.from(new Set(equipmentBlocked.flatMap((room) => (room.requiredEquipment || []).filter((item) => state.equipment.some((unit) => unit.name === item && unit.inUse >= unit.total)))));

  return (
    <div className="page">
      <section className="kpi-row" aria-label="Theatre scheduling">
        <KpiTile label="Theatre utilisation" icon={Scissors} value={scheduledCount + ongoingCount} caption={`of ${rooms.length} theatres in use today`} progress={Math.round(((scheduledCount + ongoingCount) / Math.max(rooms.length, 1)) * 100)} />
        <KpiTile label="Ongoing" icon={Scissors} tone="blue" value={ongoingCount} caption="Procedures in progress" />
        <KpiTile label="Scheduled" icon={CalendarClock} value={scheduledCount} caption="Later today" />
        <KpiTile label="Free theatres" icon={Scissors} tone="teal" value={rooms.filter((room) => room.status === 'Available').length} caption="Accepting a case" />
        <KpiTile label="On hold" icon={TriangleAlert} tone={rooms.some((room) => room.status === 'Held') ? 'alert' : 'teal'} value={rooms.filter((room) => room.status === 'Held').length} caption="Held, not cancelled" />
        <KpiTile label="Equipment blockers" icon={TriangleAlert} tone={blockedNames.length ? 'alert' : 'teal'} value={equipmentBlocked.length} caption={blockedNames.length ? `${blockedNames.slice(0, 2).join(', ')} at capacity` : 'No blockers'} />
      </section>

      <Panel title="Theatre status" icon={Scissors} subtitle="Free slots are held for emergencies first · open a row for the procedure record">
        <DataTable
          columns={[
            { key: 'id', header: 'OT', strong: true, render: (row) => <span className="mono">{row.id}</span> },
            { key: 'time', header: 'Time', render: (row) => (row.start ? `${row.start} – ${row.end}` : row.nextAvailableSlot ? `Free from ${row.nextAvailableSlot}` : '—') },
            { key: 'patient', header: 'Patient', render: (row) => row.patientLabel || '—' },
            { key: 'surgeon', header: 'Doctor', render: (row) => row.surgeon || '—' },
            { key: 'procedure', header: 'Procedure' },
            { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} size="sm" /> },
            {
              key: 'actions',
              header: 'Actions',
              align: 'right',
              render: (row) => (
                <div className="row row-tight">
                  {row.status === 'Held' ? (
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => actions.pushActivity(`${row.id} released for scheduling`, 'success')}>
                      Release hold
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => setPending({ room: row, action: 'hold' })}
                      disabled={row.status === 'Ongoing'}
                    >
                      Hold
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(row)}>
                    Details
                  </button>
                </div>
              ),
            },
          ]}
          rows={rooms}
          getRowKey={(row) => row.id}
        />
      </Panel>

      <section className="grid-2">
        <Panel title="Surgical backlog" icon={CalendarClock} subtitle={`${state.otBacklog.length} request(s) awaiting a slot`}>
          <DataTable
            columns={[
              { key: 'id', header: 'Request', strong: true, render: (row) => <span className="mono">{row.id}</span> },
              { key: 'patientLabel', header: 'Patient', render: (row) => row.patientLabel || '—' },
              { key: 'procedure', header: 'Procedure' },
              { key: 'priority', header: 'Priority', render: (row) => <StatusBadge status={row.priority} size="sm" /> },
              { key: 'surgeon', header: 'Doctor', render: (row) => row.surgeon || '—' },
            ]}
            rows={state.otBacklog}
            getRowKey={(row) => row.id}
            emptyTitle="No surgical requests waiting"
            emptyText="All requested procedures have a slot."
            compact
          />
        </Panel>

        <Panel title="Scheduling notes" icon={Scissors} subtitle="What to watch before releasing a slot">
          <ul className="conflict-list">
            {rooms.map((room) => (
              <li key={room.id}>
                <span className={`status-dot ${room.status === 'Held' ? 'is-alert' : room.equipmentReady ? 'is-ok' : 'is-warn'}`} aria-hidden="true" />
                <span className="conflict-list-text">
                  <span className="conflict-list-title">{room.id} · {room.procedure}</span>
                  <span className="conflict-list-meta">
                    {room.status === 'Held'
                      ? 'Held — slot released for emergency scheduling'
                      : room.equipmentReady
                        ? 'Equipment ready, staffing confirmed'
                        : 'Equipment readiness not confirmed'}
                  </span>
                </span>
                <StatusBadge status={room.status} size="sm" />
              </li>
            ))}
          </ul>
        </Panel>
      </section>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.id} · ${selected.procedure}` : ''}
        size="md"
        badge={selected ? <StatusBadge status={selected.status} size="sm" /> : null}
      >
        {selected ? (
          <>
            <div className="stat-grid cols-3">
              <StatTile label="Time" value={selected.start ? `${selected.start} – ${selected.end}` : '—'} />
              <StatTile label="Patient" value={selected.patientLabel || 'Unassigned'} />
              <StatTile label="Equipment" value={selected.equipmentReady ? 'Ready' : 'Not confirmed'} tone={selected.equipmentReady ? 'success' : 'alert'} />
            </div>
            <div className="kv">
              <span className="kv-key">Surgeon</span>
              <span className="kv-value">{selected.surgeon}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Anaesthetist</span>
              <span className="kv-value">{selected.anaesthetist}</span>
            </div>
            <div className="row row-tight">
              {selected.requiredEquipment.map((item) => (
                <span className="badge badge-neutral text-xs" key={item}>
                  {item}
                </span>
              ))}
            </div>
            {selected.notes ? <p className="text-small text-secondary">{selected.notes}</p> : null}
          </>
        ) : null}
      </DetailModal>

      <ConfirmationModal
        open={Boolean(pending)}
        title="Hold this theatre slot"
        subtitle={pending ? `${pending.room.id} · ${pending.room.procedure}` : ''}
        tone="warning"
        confirmLabel="Hold slot"
        cancelLabel="Cancel"
        onClose={() => setPending(null)}
        onConfirm={() => {
          actions.pushActivity(`${pending.room.id} held by resource coordinator — ${pending.room.procedure} awaiting a free slot`, 'alert');
          setPending(null);
        }}
        consequences={[
          `${pending?.room?.id} stops accepting new bookings.`,
          'The scheduled procedure is not cancelled and no theatre record is deleted.',
          'The theatre coordinator is notified to re-plan the slot.',
        ]}
      />
    </div>
  );
}
