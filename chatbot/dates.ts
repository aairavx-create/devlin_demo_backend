import { CONFIG } from './config';

/** Today's date (YYYY-MM-DD) in the business time zone, whatever the server's zone is. */
export function todayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timeZone }).format(new Date());
}

const noon = (ymd: string) => new Date(`${ymd}T12:00:00Z`);

export function addDays(ymd: string, days: number): string {
  const d = noon(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const weekday = (ymd: string) => noon(ymd).getUTCDay();

export function fmtDate(ymd: string): string {
  return noon(ymd).toLocaleDateString(CONFIG.locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(Date.UTC(2000, 0, 1, h, m));
  return d.toLocaleTimeString(CONFIG.locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}

/** Next N open days, starting tomorrow. */
export function workingDates(count: number): string[] {
  const out: string[] = [];
  let d = addDays(todayYmd(), 1);
  while (out.length < count) {
    if (!CONFIG.closedWeekdays.includes(weekday(d))) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}
