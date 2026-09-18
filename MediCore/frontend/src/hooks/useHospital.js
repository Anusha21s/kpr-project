import { useHospitalContext } from '../context/HospitalContext';

/** Convenience hook: hospital state, derived metrics and operational actions. */
export function useHospital() {
  return useHospitalContext();
}

export default useHospital;
