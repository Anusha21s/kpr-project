import { Link } from 'react-router-dom';
import { Compass, Hospital } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { ROLE_HOME } from '../data/hospitalData';
import EmptyState from '../components/EmptyState';

/** Friendly 404 — the prototype never leaves the operator at a dead end. */
export default function NotFound() {
  const { user } = useAuth();

  return (
    <div className="login-main" style={{ minHeight: '100vh' }}>
      <section className="login-card" style={{ width: 'min(560px, 100%)' }}>
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            <Hospital size={19} />
          </span>
          <div>
            <p className="brand-name">MediCore</p>
            <p className="brand-sub">Hospital Command Center</p>
          </div>
        </div>

        <EmptyState
          icon={Compass}
          title="That screen is not part of this deployment"
          text="The address you opened does not match any MediCore screen. Use the navigation to continue operating the command center."
          action={
            <div className="row" style={{ justifyContent: 'center' }}>
              <Link className="btn btn-primary btn-sm" to={user ? ROLE_HOME[user.role] : '/login'}>
                {user ? 'Back to my dashboard' : 'Go to sign in'}
              </Link>
            </div>
          }
        />
      </section>
    </div>
  );
}
