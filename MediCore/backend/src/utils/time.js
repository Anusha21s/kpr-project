/** Clock helpers shared by the seed-free runtime (shift blocks, labels, minutes). */

const MINUTES = { MORNING: [8 * 60, 16 * 60], EVENING: [16 * 60, 24 * 60], NIGHT: [0, 8 * 60] };

const pad = (value) => String(value).padStart(2, '0');

function formatClock(date = new Date()) {
  const hours = date.getHours();
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hours12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${pad(hours12)}:${pad(date.getMinutes())} ${suffix}`;
}

function minutesToLabel(minutes) {
  const normalised = ((minutes % 1440) + 1440) % 1440;
  const hours24 = Math.floor(normalised / 60);
  const minutesPart = normalised % 60;
  const suffix = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${pad(hours12)}:${pad(minutesPart)} ${suffix}`;
}

const nowMinutes = (date = new Date()) => date.getHours() * 60 + date.getMinutes();

/** Current shift block, derived from the wall clock. */
function currentShift(date = new Date()) {
  const minutes = nowMinutes(date);
  if (minutes >= MINUTES.MORNING[0] && minutes < MINUTES.MORNING[1]) return { id: 'MORNING', label: '08:00 AM – 04:00 PM' };
  if (minutes >= MINUTES.EVENING[0]) return { id: 'EVENING', label: '04:00 PM – 12:00 AM' };
  return { id: 'NIGHT', label: '12:00 AM – 08:00 AM' };
}

/** The next shift block after the current one. */
function nextShift(date = new Date()) {
  const current = currentShift(date);
  if (current.id === 'MORNING') return { id: 'EVENING', label: '04:00 PM – 12:00 AM' };
  if (current.id === 'EVENING') return { id: 'NIGHT', label: '12:00 AM – 08:00 AM' };
  return { id: 'MORNING', label: '08:00 AM – 04:00 PM' };
}

/** ISO time of the day applied to a date, used for duty rows. */
function startOfShift(date = new Date()) {
  const copy = new Date(date);
  const shift = currentShift(date);
  copy.setHours(shift.id === 'NIGHT' ? 0 : shift.id === 'MORNING' ? 8 : 16, 0, 0, 0);
  return copy;
}

module.exports = { formatClock, minutesToLabel, nowMinutes, currentShift, nextShift, startOfShift, MINUTES };
