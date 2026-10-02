/* Medication schedule rules, shared by the web app and the reminder
 * function (a copy is in supabase/functions/_shared/, made by
 * scripts/deploy-functions.sh). Plain ES module, no dependencies.
 *
 * Days are local "YYYY-MM-DD" strings and times local "HH:MM" strings, so
 * a dose at 22:00 stays at 22:00 whatever the time zone of the server. */

/** Reminders for a dose are sent until this many minutes after it is due. */
export const REMIND_WINDOW = 30;

export const pad = (n) => String(n).padStart(2, '0');
export const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const utc = (day) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
export const addDays = (day, n) => new Date(utc(day) + n * 86400000).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);
/** 1 = Monday … 7 = Sunday */
export const isoWeekday = (day) => ((new Date(utc(day)).getUTCDay() + 6) % 7) + 1;
export const minutesOf = (at) => +at.slice(0, 2) * 60 + +at.slice(3, 5);

export const doseId = (medId, day, at) => `${medId}@${day}T${at}`;

/** Local day and minute of the day in a time zone (IANA name), or in the
 *  device's zone when tz is empty. */
export function localNow(tz, date = new Date()) {
  if (!tz) return { day: dayOf(date), min: date.getHours() * 60 + date.getMinutes() };
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}

/** Is the medication scheduled on this day? */
export function occursOn(med, day) {
  if (med.deleted || med.paused) return false;
  if (med.start && day < med.start) return false;
  if (med.end && day > med.end) return false;
  if (med.repeat === 'weekdays') return (med.weekdays || []).includes(isoWeekday(day));
  if (med.repeat === 'interval') {
    const n = Math.max(1, med.interval || 1);
    return daysBetween(med.start || day, day) % n === 0;
  }
  return true; // daily
}

/** The scheduled doses of a day: [{ id, med, day, at, dose }], by time. */
export function dosesOn(meds, day) {
  const out = [];
  for (const med of meds) {
    if (!occursOn(med, day)) continue;
    for (const t of med.times || []) out.push({ id: doseId(med.id, day, t.at), med, day, at: t.at, dose: t.dose ?? 1 });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.med.name.localeCompare(b.med.name));
}

/** Which reminder (0, 1, …) is due for a dose now, or null. Reminder k is
 *  due `k * again` minutes after the dose time, for REMIND_WINDOW minutes. */
export function reminderStep(med, day, at, now) {
  const r = med.remind || {};
  const since = daysBetween(day, now.day) * 1440 + now.min - minutesOf(at);
  if (since < 0) return null;
  const count = r.again > 0 ? Math.max(1, r.count || 1) : 1;
  for (let k = count - 1; k >= 0; k--) {
    const t = k * (r.again || 0);
    if (since >= t && since - t < REMIND_WINDOW) return k;
  }
  return null;
}

/** Reminders to send now on a channel ('phone' or 'watch').
 *  doses: map id -> dose record (taken, skipped); sent: map id -> reminders
 *  already sent. Returns [{ id, med, day, at, dose, step }]. */
export function dueReminders(meds, doses, sent, now, channel) {
  const out = [];
  for (const day of [addDays(now.day, -1), now.day]) {
    for (const d of dosesOn(meds.filter((m) => m.remind && m.remind[channel]), day)) {
      const rec = doses[d.id];
      if (rec && !rec.deleted) continue;
      const step = reminderStep(d.med, d.day, d.at, now);
      if (step != null && (sent[d.id] || 0) <= step) out.push({ ...d, step });
    }
  }
  return out;
}

/** "1 pill", "2 puffs", "0.5 pill" */
export function doseText(dose, unit) {
  const u = unit || '';
  return `${dose} ${u}${dose !== 1 && u && !u.endsWith('s') ? 's' : ''}`.trim();
}
