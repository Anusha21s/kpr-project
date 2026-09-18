import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, ExternalLink } from 'lucide-react';
import { useHospital } from '../hooks/useHospital';
import { useAuth } from '../hooks/useAuth';
import StatusBadge from './StatusBadge';
import EmptyState from './EmptyState';
import { formatClock } from '../utils/time';
import { resolveActionTarget } from '../utils/navigation';

/** Header notification panel: active alerts with acknowledge and drill-through. */
export default function NotificationPanel() {
  const { state, actions } = useHospital();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const navigate = useNavigate();

  const activeAlerts = state.alerts.filter((alert) => alert.status !== 'Resolved');
  const criticalCount = activeAlerts.filter((alert) => alert.type === 'Critical').length;

  useEffect(() => {
    if (!open) return undefined;
    const onClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openAlert = (alert) => {
    setOpen(false);
    navigate(resolveActionTarget(user?.role, alert.action?.to));
  };

  return (
    <div className="popover-anchor" ref={containerRef}>
      <button
        type="button"
        className={`icon-button ${criticalCount > 0 ? 'has-dot' : ''}`}
        aria-label={`Notifications: ${activeAlerts.length} active${criticalCount ? `, ${criticalCount} critical` : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={17} />
      </button>

      {open ? (
        <div className="menu-popover menu-popover-wide" role="dialog" aria-label="Notifications">
          <div className="row-between" style={{ padding: '4px 8px 8px' }}>
            <div>
              <p className="menu-item-title">Alert centre</p>
              <p className="menu-item-sub">
                {activeAlerts.length} open · {criticalCount} critical
              </p>
            </div>
            {activeAlerts.length ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => actions.acknowledgeAll()}>
                <CheckCheck size={13} aria-hidden="true" />
                Acknowledge all
              </button>
            ) : null}
          </div>

          <div className="menu-section" style={{ maxHeight: 340, overflowY: 'auto' }}>
            {activeAlerts.length ? (
              activeAlerts.slice(0, 6).map((alert) => (
                <button type="button" className="menu-item" key={alert.id} onClick={() => openAlert(alert)}>
                  <span
                    className={`status-dot ${alert.type === 'Critical' ? 'is-alert' : 'is-info'}`}
                    style={{ marginTop: 6 }}
                    aria-hidden="true"
                  />
                  <span style={{ minWidth: 0 }}>
                    <span className="menu-item-title">{alert.title}</span>
                    <span className="menu-item-sub" style={{ display: 'block' }}>
                      {alert.affectedResource} · {formatClock(new Date(alert.timestamp))} · {alert.status}
                    </span>
                  </span>
                </button>
              ))
            ) : (
              <EmptyState title="No open alerts" text="All hospital monitors are within configured thresholds." inline />
            )}
          </div>

          <div className="menu-section">
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                navigate(resolveActionTarget(user?.role, '/command/alerts'));
              }}
            >
              <ExternalLink size={14} className="text-secondary" style={{ marginTop: 3 }} aria-hidden="true" />
              <span>
                <span className="menu-item-title">Open alert centre</span>
                <span className="menu-item-sub" style={{ display: 'block' }}>
                  Filter, acknowledge and resolve alerts
                </span>
              </span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Alert severity summary used by page headers. */
export function AlertSummaryPill({ alerts }) {
  const critical = alerts.filter((alert) => alert.type === 'Critical').length;
  return (
    <div className="row row-tight">
      {critical ? <StatusBadge status="Critical" label={`${critical} critical`} size="sm" /> : null}
      <StatusBadge status="Operational" label={`${alerts.length - critical} operational`} size="sm" />
    </div>
  );
}
