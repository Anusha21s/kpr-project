import { Activity } from 'lucide-react';
import { useHospital } from '../hooks/useHospital';

/** Live operational activity feed (section 40). */
export default function ActivityFeed({ title = 'Live activity', limit = 8, showHeader = true }) {
  const { activity, actions } = useHospital();
  const entries = activity.slice(0, limit);

  return (
    <section className="card" aria-label={title}>
      {showHeader ? (
        <header className="card-header">
          <div>
            <h3 className="card-title">
              <Activity size={16} className="text-blue" aria-hidden="true" />
              {title}
            </h3>
            <p className="card-subtitle">Operational events as they are recorded by the hospital data layer</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={actions.refresh}>
            Refresh feed
          </button>
        </header>
      ) : null}

      <ul className="activity-list">
        {entries.map((entry) => (
          <li className="activity-item" key={entry.id}>
            <span className="activity-time">{entry.time}</span>
            <span className={`activity-marker is-${entry.type}`} aria-hidden="true" />
            <span className="activity-text">{entry.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
