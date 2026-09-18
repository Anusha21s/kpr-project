import { Inbox } from 'lucide-react';

/** Consistent empty state used by tables, panels and lists. */
export default function EmptyState({ icon: Icon = Inbox, title = 'Nothing to display', text, action, inline = false }) {
  return (
    <div className="empty-state" style={inline ? { padding: '20px 16px' } : undefined}>
      <span className="empty-state-icon" aria-hidden="true">
        <Icon size={20} />
      </span>
      <p className="empty-state-title">{title}</p>
      {text ? <p className="empty-state-text">{text}</p> : null}
      {action ? <div style={{ marginTop: 6 }}>{action}</div> : null}
    </div>
  );
}
