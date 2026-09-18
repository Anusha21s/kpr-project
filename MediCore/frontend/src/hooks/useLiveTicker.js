import { useEffect, useMemo, useState } from 'react';
import { ACTIVITY_TEMPLATES, ACTIVITY_SEED, getCurrentShiftBlock } from '../data/hospitalData';
import { formatClock } from '../utils/time';

/**
 * Drives the "real-time" feel of the prototype:
 *  - a clock used by every "last updated" indicator
 *  - a ticking queue timer (1 queue-minute per real minute)
 *  - a rotating activity feed so the command center always shows movement
 *
 * Everything is deterministic — item selection is derived from the tick count.
 */
export function useLiveTicker({ intervalMs = 5000 } = {}) {
  const [now, setNow] = useState(() => new Date());
  const [tick, setTick] = useState(0);
  const [activity, setActivity] = useState(() => ACTIVITY_SEED);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date());
      setTick((value) => value + 1);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  useEffect(() => {
    if (tick === 0) return;
    // One new activity line every 4 ticks (~20s) keeps the feed alive without noise.
    if (tick % 4 !== 0) return;
    const template = ACTIVITY_TEMPLATES[(tick / 4 - 1) % ACTIVITY_TEMPLATES.length];
    setActivity((entries) => [
      { id: `ACT-live-${tick}`, time: formatClock(new Date()), text: template.text, type: template.type },
      ...entries,
    ].slice(0, 12));
  }, [tick]);

  const pushActivity = (text, type = 'info') =>
    setActivity((entries) => [
      { id: `ACT-${Date.now()}-${entries.length}`, time: formatClock(new Date()), text, type },
      ...entries,
    ].slice(0, 16));

  const clock = useMemo(() => formatClock(now, true), [now]);
  const elapsedMinutes = Math.floor((tick * intervalMs) / 60000);

  return { now, tick, clock, activity, pushActivity, elapsedMinutes, shift: getCurrentShiftBlock(now) };
}
