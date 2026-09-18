import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useHospital } from '../hooks/useHospital';
import { ROLE_LABELS } from '../data/hospitalData';
import { initials } from '../utils/display';

/**
 * Header user menu — identity, duty context and sign out (section 11).
 * Demo-only controls were moved out of the production surface.
 */
export default function UserProfile() {
  const { user, logout } = useAuth();
  const { state, clock } = useHospital();
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const navigate = useNavigate();

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

  if (!user) return null;

  const signOut = () => {
    setOpen(false);
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="popover-anchor" ref={containerRef}>
      <button
        type="button"
        className="user-chip"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`avatar ${user.role === 'resource_coordinator' ? 'avatar--teal' : ''}`} aria-hidden="true">
          {initials(user.name)}
        </span>
        <span className="user-meta">
          <span className="user-name">{user.name}</span>
          <span className="user-role">{ROLE_LABELS[user.role]}</span>
        </span>
        <ChevronDown size={14} className="text-secondary" aria-hidden="true" />
      </button>

      {open ? (
        <div className="menu-popover" role="menu">
          <div className="menu-section">
            <div className="menu-label">Signed in</div>
            <div style={{ padding: '0 10px 8px' }}>
              <div className="kv">
                <span className="kv-key">Staff ID</span>
                <span className="kv-value mono">{user.staffRef}</span>
              </div>
              <div className="kv">
                <span className="kv-key">Department</span>
                <span className="kv-value">{user.department}</span>
              </div>
              <div className="kv">
                <span className="kv-key">Shift</span>
                <span className="kv-value">{state.meta.shift.label}</span>
              </div>
              <div className="kv">
                <span className="kv-key">Clock</span>
                <span className="kv-value mono">{clock}</span>
              </div>
            </div>
          </div>

          <div className="menu-section">
            <button type="button" className="menu-item" role="menuitem" onClick={signOut}>
              <LogOut size={14} className="text-secondary" aria-hidden="true" />
              <span className="menu-item-title">Sign out</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
