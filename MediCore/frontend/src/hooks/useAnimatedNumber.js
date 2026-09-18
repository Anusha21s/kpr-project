import { useEffect, useRef, useState } from 'react';

/**
 * Animates a number towards its target so live values move smoothly and
 * subtly instead of jumping. Used by the surge simulation and the KPI cards.
 */
export function useAnimatedNumber(target, duration = 700) {
  const [value, setValue] = useState(target);
  const valueRef = useRef(target);

  useEffect(() => {
    const from = valueRef.current;
    const delta = target - from;
    if (delta === 0) return undefined;
    const steps = Math.max(1, Math.round(duration / 40));
    let step = 0;
    const timer = window.setInterval(() => {
      step += 1;
      const eased = 1 - (1 - step / steps) ** 3;
      const next = step >= steps ? target : from + delta * eased;
      valueRef.current = next;
      setValue(next);
      if (step >= steps) window.clearInterval(timer);
    }, 40);
    return () => window.clearInterval(timer);
  }, [target, duration]);

  return value;
}

/** Same as useAnimatedNumber but rounded — used by the live counters. */
export function useAnimatedInteger(target, duration = 700) {
  return Math.round(useAnimatedNumber(target, duration));
}

export default useAnimatedNumber;
