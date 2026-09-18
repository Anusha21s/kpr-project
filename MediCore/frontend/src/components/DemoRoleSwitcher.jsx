import { useNavigate } from 'react-router-dom';
import { ArrowRight, UserCog } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { ROLE_HOME, ROLE_LABELS } from '../data/hospitalData';

/**
 * Demonstration helper: jump between the three dashboards without signing out
 * manually. Hospital state is preserved because the operational store lives
 * above the route tree, which is exactly what the demo flow needs
 * (command center → coordinator → back to command center).
 */
export default function DemoRoleSwitcher({ target, label, description, variant = 'btn-secondary' }) {
  const { switchRole } = useAuth();
  const navigate = useNavigate();

  const handleSwitch = () => {
    const account = switchRole(target);
    if (account) navigate(ROLE_HOME[account.role], { replace: true });
  };

  return (
    <div className="card card--accent-teal">
      <div className="card-body row-between">
        <div className="stack-sm" style={{ maxWidth: '70ch' }}>
          <h3 className="card-title">
            <UserCog size={16} className="text-teal" aria-hidden="true" />
            Demonstration step: continue as {ROLE_LABELS[target]}
          </h3>
          <p className="text-small text-secondary">{description}</p>
        </div>
        <button type="button" className={`btn ${variant}`} onClick={handleSwitch}>
          {label}
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
