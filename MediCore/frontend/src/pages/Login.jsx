import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Hospital, Info } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { ROLE_HOME } from '../data/hospitalData';

/**
 * MediCore sign-in (section 3).
 *
 * Only what is required to authenticate: brand, staff ID, password, sign in and
 * password help. No feature lists, no statistics, no credential hints. The role
 * is derived from the authenticated staff record — never selected here.
 */
export default function Login() {
  const { login, isAuthenticated, user, isSubmitting, serviceNote } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [staffId, setStaffId] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);

  if (isAuthenticated) {
    return <Navigate to={ROLE_HOME[user.role] || '/command'} replace />;
  }

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    const result = await login(staffId, password);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const from = location.state?.from;
    navigate(from && from !== '/login' ? from : result.redirectTo, { replace: true });
  };

  return (
    <div className="login-page">
      <main className="login-card" aria-labelledby="login-heading">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            <Hospital size={20} />
          </span>
          <h1 id="login-heading" className="login-title">
            MediCore
          </h1>
          <p className="login-sub">Hospital Command Center &amp; Resource Optimization</p>
        </div>

        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}

        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <label className="field" htmlFor="staffId">
            <span className="field-label">Staff ID</span>
            <input
              id="staffId"
              className="input"
              name="staffId"
              autoComplete="username"
              autoFocus
              value={staffId}
              onChange={(event) => setStaffId(event.target.value)}
              placeholder="Enter your staff ID"
              required
            />
          </label>

          <label className="field" htmlFor="password">
            <span className="field-label">Password</span>
            <span className="input-wrap">
              <input
                id="password"
                className="input"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                required
              />
              <button
                type="button"
                className="icon-button input-affix"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </span>
          </label>

          <button type="submit" className="btn btn-primary btn-block" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Login'}
          </button>
        </form>

        <button type="button" className="login-help" onClick={() => setHelpOpen((value) => !value)} aria-expanded={helpOpen}>
          Forgot password?
        </button>

        {helpOpen ? (
          <p className="login-help-text" role="status">
            <Info size={13} aria-hidden="true" />
            Password resets are handled by the hospital IT desk on extension 4400.
          </p>
        ) : null}

        <p className="login-footnote">Authorized hospital staff only</p>
        {serviceNote ? <p className="login-footnote is-muted">{serviceNote}</p> : null}
      </main>
    </div>
  );
}
