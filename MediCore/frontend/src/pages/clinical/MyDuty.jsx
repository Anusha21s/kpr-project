import { useState } from 'react';
import { Bell, ClipboardList, Clock, Users } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import StatTile from '../../components/StatTile';
import StatusBadge from '../../components/StatusBadge';
import QuickActionGrid from '../../components/QuickActionGrid';
import DataTable from '../../components/DataTable';
import DetailModal from '../../components/DetailModal';
import { useHospital } from '../../hooks/useHospital';
import { useAuth } from '../../hooks/useAuth';
import { getNextShiftBlock } from '../../data/hospitalData';
import { getPatientsForUser, getTasksForRole } from '../../data/clinical';

/**
 * My Duty — shift, assignment, my patients and the tasks that belong to the
 * shift (the separate Tasks page was merged here in v2).
 */
export default function MyDuty() {
  const { state, metrics, actions } = useHospital();
  const { user } = useAuth();
  const [selected, setSelected] = useState(null);
  const [note, setNote] = useState('');

  const nextShift = getNextShiftBlock(new Date());
  const myPatients = getPatientsForUser(user.staffRef);
  const myTasks = getTasksForRole(user.role, user.staffRef).map((task) => ({
    ...task,
    liveStatus: state.clinicalTasks[task.id]?.status || 'Open',
    lastNote: state.clinicalTasks[task.id]?.note || null,
  }));
  const openTasks = myTasks.filter((task) => task.liveStatus !== 'Completed');

  return (
    <div className="page">
      <section className="kpi-row" aria-label="My shift">
        <KpiTile label="Shift" icon={Clock} value={state.meta.shift.label} caption={state.meta.shift.id === 'EVENING' ? 'Evening block' : 'Morning block'} />
        <KpiTile label="Status" icon={ClipboardList} tone="teal" value="On duty" caption={user.title} />
        <KpiTile label="Department" icon={Users} value={user.department} caption="Primary assignment" />
        <KpiTile label="My patients" icon={Users} value={myPatients.length} caption="Under my care" to="/clinical/patients" />
        <KpiTile label="Open tasks" icon={ClipboardList} tone={openTasks.length ? 'blue' : 'teal'} value={openTasks.length} caption={`${openTasks.filter((task) => task.priority === 'Critical').length} critical`} />
        <KpiTile label="Next shift" icon={Clock} value={nextShift.label} caption="Follows this block" />
      </section>

      <section className="grid-2">
        <Panel title="Assignment" icon={ClipboardList} subtitle="What I am responsible for this shift">
          <div className="stat-grid cols-2">
            <StatTile label="Role" value={user.title} hint={user.department} />
            <StatTile label="Staff ID" value={user.staffRef} hint="Session identity" />
            <StatTile label="Area" value={myPatients[0]?.ward || user.department} hint={`${myPatients.length} patient(s)`} />
            <StatTile label="Shift window" value={state.meta.shift.label} hint="Posted block" />
          </div>
          <p className="panel-note">
            Resources are coordinated by the command center and the resource coordinator. Clinical decisions remain with the treating
            team.
          </p>
        </Panel>

        <Panel title="Duty actions" icon={ClipboardList} subtitle="Recorded in the shift log visible to the command center">
          <QuickActionGrid
            columns={2}
            actions={[
              {
                label: 'Acknowledge duty brief',
                hint: state.meta.shift.label,
                icon: ClipboardList,
                tone: 'teal',
                onClick: () => actions.pushActivity(`${user.name} acknowledged the duty brief for ${state.meta.shift.label}`, 'info'),
              },
              {
                label: 'Request handover notes',
                hint: 'From the incoming team',
                icon: Users,
                onClick: () => actions.pushActivity(`${user.name} requested handover notes from the incoming team`, 'info'),
              },
              { label: 'My patients', hint: `${myPatients.length} under my care`, icon: Users, to: '/clinical/patients' },
              { label: 'Notifications', hint: `${metrics.activeAlerts.length} open`, icon: Bell, to: '/clinical/notifications' },
            ]}
          />
        </Panel>
      </section>

      <Panel
        title="My tasks"
        icon={ClipboardList}
        subtitle={`${openTasks.length} open of ${myTasks.length} · complete or note tasks from here`}
      >
        <DataTable
          columns={[
            { key: 'title', header: 'Task', strong: true },
            { key: 'department', header: 'Department' },
            { key: 'priority', header: 'Priority', render: (row) => <StatusBadge status={row.priority} size="sm" /> },
            { key: 'dueTime', header: 'Due' },
            {
              key: 'liveStatus',
              header: 'Status',
              render: (row) => (
                <StatusBadge
                  status={row.liveStatus === 'Completed' ? 'Resolved' : 'Pending Review'}
                  label={row.liveStatus}
                  size="sm"
                />
              ),
            },
            {
              key: 'actions',
              header: 'Actions',
              align: 'right',
              render: (row) => (
                <div className="row row-tight">
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => {
                      setSelected(row);
                      setNote('');
                    }}
                  >
                    Open
                  </button>
                  {row.liveStatus !== 'Completed' ? (
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => actions.completeTask(row.id)}>
                      Complete
                    </button>
                  ) : null}
                </div>
              ),
            },
          ]}
          rows={myTasks}
          getRowKey={(row) => row.id}
          onRowClick={(row) => {
            setSelected(row);
            setNote('');
          }}
          emptyTitle="No tasks assigned"
          emptyText="Tasks assigned to your role for this shift appear here."
        />
      </Panel>

      <section className="grid-2">
        <Panel title="Shift composition" icon={Users} subtitle="Staff on duty in this block">
          <DataTable
            columns={[
              { key: 'label', header: 'Group', strong: true },
              { key: 'value', header: 'On duty' },
              { key: 'note', header: 'Note' },
            ]}
            rows={[
              { label: 'Doctors', value: metrics.doctors.onDuty, note: `${metrics.doctors.available} available for assignment` },
              { label: 'Nurses', value: metrics.nurses.onDuty, note: `${metrics.nurses.atConstraint} at workload limit` },
              { label: 'ICU cover', value: Math.round(metrics.nurses.onDuty / 3), note: 'Estimated critical-care cover' },
              { label: 'Theatre cover', value: state.otRooms.filter((room) => room.status === 'Ongoing' || room.status === 'Scheduled').length, note: 'Active procedures' },
            ]}
            getRowKey={(row) => row.label}
            compact
          />
        </Panel>

        <Panel title="My patients" icon={Users} subtitle={`${myPatients.length} patient(s) under my care`} linkTo="/clinical/patients" linkLabel="All patients">
          <DataTable
            columns={[
              { key: 'bed', header: 'Bed', strong: true, render: (row) => <span className="mono">{row.bed}</span> },
              { key: 'name', header: 'Patient' },
              { key: 'priority', header: 'Priority', render: (row) => <StatusBadge status={row.priority} size="sm" /> },
            ]}
            rows={myPatients.slice(0, 5)}
            getRowKey={(row) => row.id}
          />
        </Panel>
      </section>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => {
          setSelected(null);
          setNote('');
        }}
        title={selected?.title}
        subtitle={selected ? `${selected.department} · due ${selected.dueTime}` : ''}
        badge={selected ? <StatusBadge status={selected.priority} size="sm" /> : null}
        footer={
          selected ? (
            <>
              <button
                type="button"
                className="btn btn-outline"
                disabled={!note.trim()}
                onClick={() => {
                  actions.addTaskNote(selected.id, note.trim());
                  setNote('');
                }}
              >
                Save note
              </button>
              {selected.liveStatus !== 'Completed' ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    actions.completeTask(selected.id);
                    setSelected(null);
                  }}
                >
                  Mark complete
                </button>
              ) : null}
            </>
          ) : null
        }
      >
        {selected ? (
          <>
            <div className="stat-grid cols-3">
              <StatTile label="Patient" value={selected.patientId || 'Ward-wide'} hint={selected.patientId ? 'Linked record' : 'No single patient'} />
              <StatTile label="Category" value={selected.category} />
              <StatTile label="Status" value={selected.liveStatus} hint={`Due ${selected.dueTime}`} />
            </div>
            <p className="text-small text-secondary">{selected.detail}</p>
            {selected.lastNote ? (
              <div className="kv">
                <span className="kv-key">Last note</span>
                <span className="kv-value">{selected.lastNote}</span>
              </div>
            ) : null}
            <label className="field">
              <span className="field-label">Add a note</span>
              <textarea
                className="input"
                rows={3}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Record what was done for the incoming team"
              />
            </label>
          </>
        ) : null}
      </DetailModal>
    </div>
  );
}
