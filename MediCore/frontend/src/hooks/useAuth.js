import { useAuthContext } from '../context/AuthContext';

/** Convenience hook for session data and demo authentication actions. */
export function useAuth() {
  return useAuthContext();
}

export default useAuth;
