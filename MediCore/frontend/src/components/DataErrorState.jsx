import { RefreshCw, TriangleAlert } from 'lucide-react';

/**
 * DataErrorState — concise failure message with a retry (section 36).
 * Raw backend errors are never shown to staff.
 */
export default function DataErrorState({ title = 'Unable to load hospital data', text, onRetry, compact }) {
  return (
    <div className={`data-error ${compact ? 'is-compact' : ''}`} role="alert">
      <span className="data-error-icon" aria-hidden="true">
        <TriangleAlert size={16} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <p className="data-error-title">{title}</p>
        {text ? <p className="data-error-text">{text}</p> : null}
      </div>
      {onRetry ? (
        <button type="button" className="btn btn-outline btn-sm" onClick={onRetry}>
          <RefreshCw size={13} aria-hidden="true" />
          Retry
        </button>
      ) : null}
    </div>
  );
}
