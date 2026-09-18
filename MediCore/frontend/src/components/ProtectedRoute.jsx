import { Navigate, useLocation } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { ROLE_HOME, ROLE_LABELS } from '../data/hospitalData';
import EmptyState from './EmptyState';
import { Link } from 'react-router-dom';

/**
 * Role-based route protection.
 * Unauthenticated users are redirected to sign-in (remembering where they were
 * heading); authenticated users without the role for a dashboard get an
 * explicit access notice with a route back to their own dashboard — never a
 * dead end or a blank screen.
 */
export default function ProtectedRoute({ allowedRoles, children }) {
  const { user, isAuthenticated } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return (
      <div className="page">
        <section className="card">
          <EmptyState
            icon={ShieldAlert}
            title="This area is not assigned to your role"
            text={`${ROLE_LABELS[user.role]} accounts do not have access to this dashboard. Sign in with a different demo account to view it, or return to your own dashboard.`}
            action={
              <div className="row" style={{ justifyContent: 'center' }}>
                <Link className="btn btn-primary btn-sm" to={ROLE_HOME[user.role]}>
                  Go to my dashboard
                </Link>
                <Link className="btn btn-outline btn-sm" to="/login">
                  Switch account
                </Link>
              </div>
            }
          />
        </section>
      </div>
    );
  }

  return children;
}
