import { Link } from 'react-router-dom';
import {
  BedDouble,
  Bell,
  CalendarClock,
  ClipboardList,
  HeartPulse,
  ListChecks,
  Siren,
  Users,
} from 'lucide-react';
import KpiTile from '../../components/KpiTile';
import Panel from '../../components/Panel';
import QuickActionGrid from '../../components/QuickActionGrid';
import DataTable from '../../components/DataTable';
import StatusBadge from '../../components/StatusBadge';
import ActivityFeed from '../../components/ActivityFeed';
import { useHospital } from '../../hooks/useHospital';
import { useAuth } from '../../hooks/useAuth';
import { getPatientsForUser, getTasksForRole } from '../../data/clinical';
import { rankQueue } from '../../utils/optimizationEngine';

/**
 * Clinical dashboard (section 23) — only what is relevant to the current duty.
 * Doctors see their patients, theatre list and pending actions; nurses see
 * assigned patients, ward monitoring and tasks. No resource-management controls.
 */
export default function ClinicalOverview() {
  const { state, metrics } = useHospital();
  const { user } = useAuth();

  const isDoctor = user.role === 'doctor';
  const myPatients = getPatientsForUser(user.staffRef);
  const myTasks = getTasksForRole(user.role, user.staffRef).filter((task) => state.clinicalTasks[task.id]?.status !== 'Completed');
  const emergencyCases = rankQueue(state.queue).filter((entry) => entry.priority === 'Critical' || entry.priority === 'High');
  const otActive = state.otRooms.filter((room) => room.status === 'Ongoing' || room.status === 'Scheduled');

  return (
    <div className="page">
      {myTasks.some((task) => task.priority === 'Critical') ? (
        <div className="alert-line is-critical" role="status">
          <div className="alert-line-main">
            <span className="alert-line-title">
              {myTasks.filter((task) => task.priority === 'Critical').length} critical task requires attention
            </span>
            <span className="alert-line-meta">{myTasks.filter((task) => task.priority === 'Critical')[0].title}</span>
          </div>
          <Link className="btn btn-outline btn-sm" to="/clinical/duty">
            Open tasks
          </Link>
        </div>
      ) : null}

      <section className="kpi-row" aria-label="My duty">
        <KpiTile
          label={isDoctor ? 'My patients' : 'Assigned patients'}
          icon={Users}
          value={myPatients.length}
          caption={isDoctor ? 'Under my care this shift' : 'Within my assignment'}
          to="/clinical/patients"
        />
        <KpiTile
          label="Emergency cases"
          icon={Siren}
          tone={emergencyCases.some((entry) => entry.priority === 'Critical') ? 'alert' : 'blue'}
          value={emergencyCases.length}
          caption="Awaiting a resource"
          to="/clinical/emergency"
        />
        {isDoctor ? (
          <KpiTile label="Theatre list" icon={CalendarClock} value={otActive.length} caption="Procedures today" to="/clinical/ot" />
        ) : (
          <KpiTile
            label="ICU / ward"
            icon={BedDouble}
            tone={metrics.beds.icu.available <= 1 ? 'alert' : 'blue'}
            value={metrics.beds.icu.available}
            caption={`ICU beds vacant · ${metrics.beds.icu.occupied} occupied`}
            to="/clinical/icu"
          />
        )}
        <KpiTile
          label={isDoctor ? 'Pending actions' : 'Ward tasks'}
          icon={ListChecks}
          tone={myTasks.some((task) => task.priority === 'Critical') ? 'alert' : myTasks.length ? 'blue' : 'teal'}
          value={myTasks.length}
          caption={`${myTasks.filter((task) => task.priority === 'Critical').length} critical · manage under My duty`}
          to="/clinical/duty"
        />
      </section>

      <section className="grid-2">
        <Panel
          title="My patients"
          icon={Users}
          subtitle={`${myPatients.length} patient(s) under my care`}
          linkTo="/clinical/patients"
          linkLabel="All patients"
        >
          <DataTable
            columns={[
              { key: 'bed', header: 'Bed', strong: true, render: (row) => <span className="mono">{row.bed}</span> },
              { key: 'name', header: 'Patient' },
              { key: 'priority', header: 'Priority', render: (row) => <StatusBadge status={row.priority} size="sm" /> },
              { key: 'status', header: 'Status' },
            ]}
            rows={myPatients.slice(0, 5)}
            getRowKey={(row) => row.id}
          />
        </Panel>

        <div className="stack-lg">
          <Panel title="Next tasks" icon={ListChecks} subtitle="Highest priority first · manage them under My duty" linkTo="/clinical/duty" linkLabel="My duty">
            <ul className="conflict-list">
              {myTasks.slice(0, 4).map((task) => (
                <li key={task.id}>
                  <span className={`status-dot ${task.priority === 'Critical' ? 'is-alert' : 'is-info'}`} aria-hidden="true" />
                  <span className="conflict-list-text">
                    <span className="conflict-list-title">{task.title}</span>
                    <span className="conflict-list-meta">Due {task.dueTime} · {task.category}</span>
                  </span>
                  <StatusBadge status={task.priority} size="sm" />
                </li>
              ))}
              {myTasks.length === 0 ? <li><p className="empty-line">No open tasks</p></li> : null}
            </ul>
          </Panel>

          <Panel title="Quick actions" icon={HeartPulse} subtitle="Clinical shortcuts for this shift">
            <QuickActionGrid
              columns={2}
              actions={[
                { label: 'Emergency cases', hint: `${emergencyCases.length} awaiting a resource`, icon: Siren, to: '/clinical/emergency', tone: 'alert' },
                { label: 'ICU / Ward', hint: `${metrics.beds.icu.available} ICU beds vacant`, icon: BedDouble, to: '/clinical/icu' },
                { label: 'My duty', hint: state.meta.shift.label, icon: ClipboardList, to: '/clinical/duty' },
                { label: 'Notifications', hint: `${metrics.activeAlerts.length} open`, icon: Bell, to: '/clinical/notifications' },
              ]}
            />
          </Panel>
        </div>
      </section>

      <ActivityFeed title="Ward activity" limit={6} />
    </div>
  );
}
