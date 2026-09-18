import { useState } from 'react';
import { CalendarClock, Scissors, TriangleAlert } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import DataTable from '../../components/DataTable';
import StatusBadge from '../../components/StatusBadge';
import DetailModal from '../../components/DetailModal';
import StatTile from '../../components/StatTile';
import { useHospital } from '../../hooks/useHospital';
import { useAuth } from '../../hooks/useAuth';

const DAY_START = 8 * 60;
const DAY_END = 17 * 60;
const SPAN = DAY_END - DAY_START;
const toPercent = (minutes) => Math.max(0, Math.min(((minutes - DAY_START) / SPAN) * 100, 100));

/**
 * OT Schedule (clinical) — operational table (section 18) plus a single compact
 * timeline. Conflicts are highlighted; medical detail stays out of the list.
 */
export default function OtSchedule() {
  const { state, actions } = useHospital();
  const { user } = useAuth();
  const [selected, setSelected] = useState(null);

  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
  const isDoctor = user.role === 'doctor';
  const myRoom = state.otRooms.find((room) => room.surgeonRef === user.staffRef);

  return (
    <div className="page">
      {state.otRooms.some((room) => room.status === 'Ongoing' && room.notes && /overrun/i.test(room.notes)) ? (
        <div className="alert-line is-operational" role="status">
          <div className="alert-line-main">
            <span className="alert-line-title">OT-01 running beyond the planned window</span>
            <span className="alert-line-meta">Following procedures may shift. The theatre coordinator has been informed.</span>
          </div>
        </div>
      ) : null}

      <section className="kpi-row" aria-label="Theatre status">
        <KpiTile label="Theatres" icon={Scissors} value={state.otRooms.length} caption="In the theatre complex" />
        <KpiTile label="Ongoing" icon={Scissors} tone="blue" value={state.otRooms.filter((room) => room.status === 'Ongoing').length} caption="In progress now" />
        <KpiTile label="Scheduled" icon={CalendarClock} value={state.otRooms.filter((room) => room.status === 'Scheduled').length} caption="Later today" />
        <KpiTile label="Free" icon={Scissors} tone="teal" value={state.otRooms.filter((room) => room.status === 'Available').length} caption="Accepting a case" />
        <KpiTile label="Maintenance" icon={TriangleAlert} tone={state.otRooms.some((room) => room.status === 'Maintenance') ? 'alert' : 'teal'} value={state.otRooms.filter((room) => room.status === 'Maintenance').length} caption="Not schedulable" />
        <KpiTile label={isDoctor ? 'My theatre' : 'Requests'} icon={CalendarClock} value={isDoctor ? myRoom?.id || '—' : state.otBacklog.length} caption={isDoctor ? myRoom?.procedure || 'No procedure assigned' : 'Surgical requests pending'} />
      </section>

      <Panel title="Theatre schedule" icon={CalendarClock} subtitle="Current time marker shown in red · open a row for the procedure detail">
        <DataTable
          columns={[
            { key: 'id', header: 'OT', strong: true, render: (row) => <span className="mono">{row.id}</span> },
            { key: 'time', header: 'Time', render: (row) => (row.start ? `${row.start} – ${row.end}` : row.nextAvailableSlot ? `Free from ${row.nextAvailableSlot}` : '—') },
            { key: 'patient', header: 'Patient', render: (row) => row.patientLabel || '—' },
            { key: 'surgeon', header: 'Doctor', render: (row) => row.surgeon || '—' },
            { key: 'procedure', header: 'Procedure' },
            { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} size="sm" /> },
          ]}
          rows={state.otRooms}
          getRowKey={(row) => row.id}
          onRowClick={(row) => setSelected(row)}
        />
      </Panel>

      <Panel title="Timeline" icon={CalendarClock} subtitle="08:00 – 17:00">
        <div className="timeline">
          {state.otRooms.map((room) => {
            const stateClass =
              room.status === 'Ongoing'
                ? 'is-ongoing'
                : room.status === 'Scheduled'
                  ? 'is-scheduled'
                  : room.status === 'Held'
                    ? 'is-held'
                    : room.status === 'Maintenance'
                      ? 'is-maintenance'
                      : 'is-available';
            const startPercent = room.startMinutes ? toPercent(room.startMinutes) : room.nextAvailableMinutes ? toPercent(room.nextAvailableMinutes) : 12;
            const widthPercent = room.startMinutes && room.endMinutes ? toPercent(room.endMinutes) - startPercent : 18;
            return (
              <div className="timeline-row" key={room.id}>
                <span className="timeline-label mono">{room.id}</span>
                <div className="timeline-track">
                  <span className={`timeline-block ${stateClass}`} style={{ left: `${startPercent}%`, width: `${Math.max(widthPercent, 12)}%` }}>
                    {room.start ? `${room.start} · ${room.status}` : room.nextAvailableSlot ? `Free ${room.nextAvailableSlot}` : room.status}
                  </span>
                  <span className="timeline-now" style={{ left: `${toPercent(nowMinutes)}%` }} aria-hidden="true" />
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.id} · ${selected.procedure}` : ''}
        subtitle={selected?.name}
        size="md"
        badge={selected ? <StatusBadge status={selected.status} size="sm" /> : null}
        footer={
          selected ? (
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => {
                actions.pushActivity(`Theatre readiness noted for ${selected.id}`, 'info');
                setSelected(null);
              }}
            >
              Note readiness
            </button>
          ) : null
        }
      >
        {selected ? (
          <>
            <div className="stat-grid cols-3">
              <StatTile label="Time" value={selected.start ? `${selected.start} – ${selected.end}` : '—'} hint={selected.nextAvailableSlot ? `Free from ${selected.nextAvailableSlot}` : 'Scheduled'} />
              <StatTile label="Patient" value={selected.patientLabel || 'Unassigned'} />
              <StatTile label="Equipment" value={selected.equipmentReady ? 'Ready' : 'Not ready'} tone={selected.equipmentReady ? 'success' : 'alert'} />
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
    </div>
  );
}
