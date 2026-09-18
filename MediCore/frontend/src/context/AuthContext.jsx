import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { ROLE_HOME, demoUsers } from '../data/hospitalData';
import api, { ApiError, BACKEND_CONFIGURED, clearToken, getToken, setToken } from '../services/api';

/**
 * Demo authentication, prepared for the Node/Express backend (section 43).
 *
 * Sign-in order:
 *   1. POST /api/auth/login — the real authentication path.
 *   2. Local staff directory — used while the backend is not reachable, so the
 *      prototype stays demonstrable. The role always comes from the staff
 *      record; it is never selected in the UI.
 *
 * The session is kept in localStorage so a refresh does not sign staff out.
 */

const STORAGE_KEY = 'medicore.session.v1';

const AuthContext = createContext(null);

const readSession = () => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.staffId) {
      if (parsed.token) setToken(parsed.token);
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
};

const persist = (session) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* storage disabled — the session stays in memory only */
  }
};

/** Attach the demo role mapping to whatever the backend returns. */
const normaliseSession = (account) => {
  const userObj = account.user || account;
  const staffId = userObj.staffId || account.staffId;
  const known = demoUsers.find((entry) => entry.staffId === staffId);
  const role = userObj.role || account.role || (known && known.role) || 'command_center';
  return {
    staffId,
    name: userObj.name || account.name || (known && known.name) || staffId,
    title: userObj.title || account.title || (known && known.title) || '',
    role,
    department: userObj.department || account.department || (known && known.department) || '',
    staffRef: userObj.staffRef || account.staffRef || (known && known.staffRef) || staffId,
    token: account.token || account.accessToken || null,
    loginAt: new Date().toISOString(),
  };
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(readSession);
  const [isSubmitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [serviceNote, setServiceNote] = useState('');
  const [backendReachable, setBackendReachable] = useState(null);

  const login = useCallback(async (staffId, password) => {
    const normalisedId = String(staffId || '').trim().toUpperCase();
    setSubmitting(true);
    setError('');

    /* ---------------------------------------------------- 1. backend path */
    if (BACKEND_CONFIGURED) {
      try {
        const response = await api.login({ staffId: normalisedId, password });
        const session = normaliseSession({ ...response, staffId: response.staffId || normalisedId });
        setToken(session.token);
        setUser(session);
        persist(session);
        setBackendReachable(true);
        setServiceNote('');
        setSubmitting(false);
        return { ok: true, user: session, redirectTo: ROLE_HOME[session.role] || '/login' };
      } catch (backendError) {
        /* A missing route (404) or a server error means there is no auth service
           to talk to — that is not a failed sign-in, so the local staff
           directory takes over. Only a real credential rejection stops here. */
        const unreachable =
          !(backendError instanceof ApiError) ||
          backendError.status === 0 ||
          backendError.status === 404 ||
          backendError.status >= 500;
        if (!unreachable) {
          setSubmitting(false);
          const message = backendError?.message || 'Sign-in could not be completed.';
          setError(message);
          return { ok: false, error: message };
        }
        setBackendReachable(false);
        setServiceNote('Hospital data service is not connected — running on the local staff directory.');
      }
    }

    /* ------------------------------------------- 2. local staff directory */
    const account = demoUsers.find((entry) => entry.staffId === normalisedId);
    if (!account || account.password !== password) {
      setSubmitting(false);
      const message = !account
        ? 'Staff ID not recognised. Check with the hospital IT desk.'
        : 'Incorrect password. Try again.';
      setError(message);
      return { ok: false, error: message };
    }

    const session = normaliseSession(account);
    setUser(session);
    persist(session);
    setSubmitting(false);
    return { ok: true, user: session, redirectTo: ROLE_HOME[session.role] || '/login' };
  }, []);

  const logout = useCallback(() => {
    if (getToken()) api.logout().catch(() => {});
    clearToken();
    setUser(null);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  /**
   * Demonstration helper used by DemoRoleSwitcher (kept out of production
   * navigation): move between the three dashboards without re-entering
   * credentials. Hospital state is preserved because the operational store
   * lives above the route tree.
   */
  const switchRole = useCallback(async (staffId) => {
    const account = demoUsers.find((entry) => entry.staffId === staffId);
    if (!account) return null;
    let token = null;
    if (BACKEND_CONFIGURED) {
      try {
        const response = await api.login({ staffId, password: account.password || 'demo123' });
        token = response?.token || (response?.user && response.user.token);
        if (token) setToken(token);
      } catch {
        /* fallback to demo session */
      }
    }
    const session = { ...normaliseSession({ ...account, token: token || account.token }), switched: true };
    setUser(session);
    persist(session);
    return session;
  }, []);

  const value = useMemo(
    () => ({
      user,
      isAuthenticated: Boolean(user),
      login,
      logout,
      switchRole,
      isSubmitting,
      error,
      serviceNote,
      backendReachable,
    }),
    [user, login, logout, switchRole, isSubmitting, error, serviceNote, backendReachable],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuthContext must be used inside AuthProvider');
  return context;
}

export default AuthContext;
