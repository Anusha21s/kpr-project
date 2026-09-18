import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

/**
 * QuickActionGrid — the primary next steps for the current dashboard
 * (section 8 command center, section 21 coordinator, section 23 clinical).
 */
export default function QuickActionGrid({ actions = [], columns = 2 }) {
  return (
    <div className={`quick-actions cols-${columns}`}>
      {actions.map((action) => {
        const content = (
          <>
            <span className={`quick-icon is-${action.tone || 'blue'}`} aria-hidden="true">
              <action.icon size={15} />
            </span>
            <span className="quick-text">
              <span className="quick-title">{action.label}</span>
              {action.hint ? <span className="quick-hint">{action.hint}</span> : null}
            </span>
            <ArrowRight size={14} className="quick-arrow" aria-hidden="true" />
          </>
        );

        return action.to ? (
          <Link className="quick-action" to={action.to} key={action.label}>
            {content}
          </Link>
        ) : (
          <button type="button" className="quick-action" key={action.label} onClick={action.onClick}>
            {content}
          </button>
        );
      })}
    </div>
  );
}
