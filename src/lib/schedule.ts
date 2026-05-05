// Scheduling helpers used by the UI (and only the UI — the DOs compute their
// own next-alarm time directly). All times are unix milliseconds, UTC.

import { nextRun } from '~/lib/cron';
import type { HeartbeatMonitorConfig, HttpMonitorConfig, MonitorRow, MonitorStateRow } from '~/lib/db';

export type MonitorView = MonitorRow & {
  state: MonitorStateRow | null;
  parsed_config: HttpMonitorConfig | HeartbeatMonitorConfig | Record<string, unknown>;
};

/**
 * When do we expect the next check/ping for this monitor?
 *   - HTTP interval:  last_check_at + interval (we drive)
 *   - HTTP cron:      nextRun(cron, now)
 *   - Heartbeat int:  last_ping_at + interval + grace (alarm will fire then)
 *   - Heartbeat cron: nextRun(cron, last_ping_at) + grace * 1000
 *   - Paused:         null
 *   - Never seen yet: now + interval (HTTP) / nextRun(cron, now) etc.
 */
export function nextExpectedAt(m: MonitorView, nowMs: number = Date.now()): number | null {
  if (m.paused) return null;
  const last = (m.state?.last_check_at ?? 0) * 1000;

  if (m.type === 'http') {
    const cfg = m.parsed_config as HttpMonitorConfig;
    if (cfg.cron_expression) {
      try { return nextRun(cfg.cron_expression, nowMs); } catch { return null; }
    }
    if (last) return last + m.interval_seconds * 1000;
    return nowMs + m.interval_seconds * 1000;
  }

  // heartbeat
  const cfg = m.parsed_config as HeartbeatMonitorConfig;
  if (cfg.cron_expression) {
    const from = last || nowMs;
    try { return nextRun(cfg.cron_expression, from) + m.grace_seconds * 1000; } catch { return null; }
  }
  if (last) return last + (m.interval_seconds + m.grace_seconds) * 1000;
  return nowMs + (m.interval_seconds + m.grace_seconds) * 1000;
}

export function relTimeUntil(targetMs: number, nowMs: number = Date.now()): string {
  const dt = targetMs - nowMs;
  const past = dt < 0;
  const s = Math.round(Math.abs(dt) / 1000);
  let str: string;
  if (s < 60)        str = `${s}s`;
  else if (s < 3600) str = `${Math.round(s / 60)}m`;
  else if (s < 86400) str = `${Math.round(s / 3600)}h`;
  else                str = `${Math.round(s / 86400)}d`;
  return past ? `${str} ago` : `in ${str}`;
}

export function fmtUtcShort(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

// ---- ISO week ----

/** ISO week-numbering year/week pair for a UTC date. Week 1 contains Jan 4. */
export function isoWeekFromDate(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday in the same week determines the year.
  const day = (t.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
  t.setUTCDate(t.getUTCDate() - day + 3);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - yearStart.getTime()) / 86_400_000 - 3 + ((yearStart.getUTCDay() + 6) % 7)) / 7);
  return { year: t.getUTCFullYear(), week };
}

/** UTC midnight of the Monday that starts the given ISO week. */
export function mondayOfIsoWeek(year: number, week: number): Date {
  // Jan 4 is always in week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7; // Mon=0
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return monday;
}

export function parseWeekParam(v: string | null | undefined): { year: number; week: number } | null {
  if (!v) return null;
  const m = /^(\d{4})-W?(\d{1,2})$/i.exec(v.trim());
  if (!m) return null;
  const year = +m[1];
  const week = +m[2];
  if (week < 1 || week > 53) return null;
  return { year, week };
}

export function formatWeekParam(y: number, w: number): string {
  return `${y}-W${String(w).padStart(2, '0')}`;
}

export function formatWeekRangeLabel(monday: Date): string {
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const yEnd = sunday.getUTCFullYear();
  return `${fmt(monday)} – ${fmt(sunday)}, ${yEnd}`;
}

/** Adjacent week, wrapping year boundaries. */
export function shiftIsoWeek(year: number, week: number, delta: number): { year: number; week: number } {
  const monday = mondayOfIsoWeek(year, week);
  monday.setUTCDate(monday.getUTCDate() + delta * 7);
  return isoWeekFromDate(monday);
}
