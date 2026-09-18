/** Time helpers shared by the live clock, queue timers and activity feed. */

export const pad2 = (value) => String(value).padStart(2, '0');

/** 24h clock with seconds — used by the "last updated" indicator. */
export function formatClock(date = new Date(), withSeconds = false) {
  const base = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return withSeconds ? `${base}:${pad2(date.getSeconds())}` : base;
}

/** 12h clock used in clinical contexts (shifts, theatre timings). */
export function formatTime12(date = new Date()) {
  const hours = date.getHours();
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${pad2(hour12)}:${pad2(date.getMinutes())} ${suffix}`;
}

/** "12:45 PM" for a Date, or "—" when no date is supplied. */
export const formatTimeLabel = (date) => (date ? formatTime12(date) : '—');

export function minutesAgoLabel(minutes, from = new Date()) {
  const target = new Date(from.getTime() - minutes * 60 * 1000);
  return formatClock(target);
}

export function minutesAgoDate(minutes, from = new Date()) {
  return new Date(from.getTime() - minutes * 60 * 1000);
}

/** Greeting used by the dashboard headers. */
export function greeting(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 17) return 'Good Afternoon';
  return 'Good Evening';
}

export function formatMinutes(minutes) {
  if (minutes == null) return '—';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${pad2(rest)} m`;
}

/** mm:ss duration used while a simulation is running. */
export function formatDuration(seconds) {
  return `${pad2(Math.floor(seconds / 60))}:${pad2(seconds % 60)}`;
}

export const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
