import { NavLink, useNavigate } from 'react-router-dom';
import { ChevronsLeft, Hospital, LogOut, X } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useHospital } from '../hooks/useHospital';
import { getBadgeCounts, getSectionForRole } from '../utils/navigation';
import { HOSPITAL, ROLE_LABELS } from '../data/hospitalData';

/**
 * Sidebar — flat role navigation, collapsible on desktop and a drawer on
 * mobile. The footer keeps only identity and sign out (section 11): system
 * status lines and demo resets are not production navigation.
 */
export default function Sidebar({ collapsed, onToggleCollapse, variant = 'desktop', onClose }) {
  const { user, logout } = useAuth();
  const { state, metrics } = useHospital();
  const navigate = useNavigate();

  const section = getSectionForRole(user?.role);
  const badges = getBadgeCounts(metrics, state, user?.role);
  const isDrawer = variant === 'drawer';
  const showLabels = !collapsed || isDrawer;

  const handleSignOut = () => {
    logout();
    onClose?.();
    navigate('/login', { replace: true });
  };

  if (!section) return null;

  const items = section.items.filter((item) => !item.roles || item.roles.includes(user.role));

  return (
    <aside className={isDrawer ? 'sidebar-drawer' : 'app-sidebar'} aria-label="Primary navigation">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <Hospital size={18} />
        </span>
        {showLabels ? (
          <div className="brand-text">
            <div className="brand-name">{HOSPITAL.product}</div>
            <div className="brand-sub">{section.label}</div>
          </div>
        ) : null}
        {isDrawer ? (
          <button type="button" className="icon-button" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close navigation">
            <X size={16} />
          </button>
        ) : null}
      </div>

      <nav className="sidebar-scroll">
        <ul className="sidebar-list">
          {items.map((item) => {
            const badgeValue = item.badge ? badges[item.badge] : null;
            return (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => `sidebar-link ${isActive ? 'is-active' : ''}`}
                  title={!showLabels ? item.label : undefined}
                  onClick={() => isDrawer && onClose?.()}
                >
                  <item.icon size={17} className="sidebar-icon" aria-hidden="true" />
                  {showLabels ? <span className="sidebar-label">{item.label}</span> : null}
                  {showLabels && badgeValue > 0 ? (
                    <span className="sidebar-badge" aria-label={`${badgeValue} items`}>
                      {badgeValue}
                    </span>
                  ) : null}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="sidebar-footer">
        {showLabels ? (
          <div className="sidebar-user">
            <p className="sidebar-user-name truncate">{user.name}</p>
            <p className="sidebar-user-role truncate">{ROLE_LABELS[user.role]}</p>
          </div>
        ) : null}

        <button type="button" className="btn btn-outline btn-sm btn-block" onClick={handleSignOut}>
          <LogOut size={13} aria-hidden="true" />
          {showLabels ? 'Sign out' : null}
        </button>

        {!isDrawer ? (
          <button
            type="button"
            className="sidebar-collapse"
            onClick={onToggleCollapse}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-expanded={!collapsed}
          >
            <ChevronsLeft size={15} aria-hidden="true" style={{ transform: collapsed ? 'rotate(180deg)' : 'none' }} />
            {showLabels ? 'Collapse' : null}
          </button>
        ) : null}
      </div>
    </aside>
  );
}
