import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Menu, RefreshCw } from 'lucide-react';
import NotificationPanel from './NotificationPanel';
import UserProfile from './UserProfile';
import { useAuth } from '../hooks/useAuth';
import { useHospital } from '../hooks/useHospital';
import { PAGE_DESCRIPTIONS, findActiveNavItem, getSectionForRole } from '../utils/navigation';

/**
 * Application header — page context, refresh, notifications, user (section 10).
 * Global search was removed: it was not connected to real data. Each list page
 * carries its own working search and filters instead.
 */
export default function Header({ onOpenDrawer }) {
  const { user } = useAuth();
  const { actions, lastUpdatedLabel } = useHospital();
  const { pathname } = useLocation();
  const [spin, setSpin] = useState(false);
  const timer = useRef(null);

  const section = getSectionForRole(user?.role);
  const activeItem = findActiveNavItem(section, user?.role, pathname);
  const title = activeItem?.label || section?.label || 'MediCore';
  const subtitle = PAGE_DESCRIPTIONS[pathname] || section?.label || '';

  useEffect(() => () => clearTimeout(timer.current), []);

  const handleRefresh = () => {
    actions.refresh();
    setSpin(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSpin(false), 600);
  };

  return (
    <header className="app-header">
      <button type="button" className="icon-button mobile-only" onClick={onOpenDrawer} aria-label="Open navigation">
        <Menu size={18} />
      </button>

      <div className="header-titles">
        <h1 className="header-title">{title}</h1>
        <p className="header-subtitle">{subtitle}</p>
      </div>

      <div className="header-actions">
        <span className="header-updated" title="Operational snapshot time">
          Updated {lastUpdatedLabel}
        </span>
        <button
          type="button"
          className="icon-button"
          onClick={handleRefresh}
          aria-label="Refresh hospital data"
          title="Refresh hospital data"
        >
          <RefreshCw size={16} className={spin ? 'is-spinning' : ''} />
        </button>
        <NotificationPanel />
        <UserProfile />
      </div>
    </header>
  );
}
