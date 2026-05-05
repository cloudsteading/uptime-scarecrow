// Minimal 5-field cron parser. Standard syntax:
//   minute  hour  day-of-month  month  day-of-week
// Each field supports: `*`, `n`, `n-m`, `n,m,o`, `*/n`, `n-m/x`.
// Day-of-week: 0-6 (Sun=0). When BOTH day-of-month and day-of-week are
// constrained (i.e. neither is `*`), a match in EITHER triggers — Vixie cron
// behavior, matching healthchecks.io.
//
// `nextRun(expr, fromMs)` returns the next-expected timestamp strictly after
// `fromMs`. Caller is responsible for adding the grace window.
//
// Time zone: UTC throughout. The Worker has no local TZ; users supply UTC
// expressions or accept the offset.

export type ParsedCron = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domStar: boolean;
  dowStar: boolean;
};

const RANGES = {
  minute:     { min: 0, max: 59 },
  hour:       { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month:      { min: 1, max: 12 },
  dayOfWeek:  { min: 0, max: 6 },
} as const;

type FieldName = keyof typeof RANGES;

const ALIASES: Record<string, string> = {
  '@yearly':   '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly':  '0 0 1 * *',
  '@weekly':   '0 0 * * 0',
  '@daily':    '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly':   '0 * * * *',
};

export function parseCron(expr: string): ParsedCron {
  const trimmed = expr.trim().toLowerCase();
  const normalized = ALIASES[trimmed] ?? expr.trim();
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have 5 fields, got ${parts.length}`);
  }
  const [m, h, dom, mon, dow] = parts;
  return {
    minute:     parseField(m,   'minute'),
    hour:       parseField(h,   'hour'),
    dayOfMonth: parseField(dom, 'dayOfMonth'),
    month:      parseField(mon, 'month'),
    dayOfWeek:  parseField(dow.replace(/7/g, '0'), 'dayOfWeek'),
    domStar: dom === '*',
    dowStar: dow === '*',
  };
}

function parseField(field: string, name: FieldName): Set<number> {
  const { min, max } = RANGES[name];
  const out = new Set<number>();
  for (const part of field.split(',')) {
    let stepStr = '1';
    let rangeStr = part;
    if (part.includes('/')) {
      const [r, s] = part.split('/');
      rangeStr = r;
      stepStr = s;
    }
    const step = Number(stepStr);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Bad step in ${name}: "${part}"`);
    }
    let from: number;
    let to: number;
    if (rangeStr === '*') {
      from = min; to = max;
    } else if (rangeStr.includes('-')) {
      const [a, b] = rangeStr.split('-').map((s) => Number(s));
      from = a; to = b;
    } else {
      const v = Number(rangeStr);
      if (step === 1) {
        if (!Number.isInteger(v) || v < min || v > max) {
          throw new Error(`Out of range ${name}: "${part}"`);
        }
        out.add(v);
        continue;
      }
      // bare number with step: "5/10" → 5,15,25,…
      from = v; to = max;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      throw new Error(`Out of range ${name}: "${part}"`);
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

export function validateCron(expr: string): { ok: true } | { ok: false; error: string } {
  try { parseCron(expr); return { ok: true }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}

/**
 * Next match strictly after `fromMs` (UTC). Returns unix ms.
 * Brute-force minute-walk; bounded to ~4 years to defeat malformed expressions.
 */
export function nextRun(expr: string, fromMs: number): number {
  const c = parseCron(expr);
  const start = new Date(fromMs);
  // Round up to the next minute boundary.
  const d = new Date(Date.UTC(
    start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(),
    start.getUTCHours(), start.getUTCMinutes() + 1, 0, 0,
  ));
  const horizonMs = fromMs + 4 * 366 * 24 * 60 * 60 * 1000;
  while (d.getTime() <= horizonMs) {
    if (
      c.month.has(d.getUTCMonth() + 1) &&
      c.hour.has(d.getUTCHours()) &&
      c.minute.has(d.getUTCMinutes()) &&
      dayMatches(c, d)
    ) {
      return d.getTime();
    }
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  throw new Error('No cron match within 4-year horizon — expression likely impossible');
}

function dayMatches(c: ParsedCron, d: Date): boolean {
  const dom = d.getUTCDate();
  const dow = d.getUTCDay();
  const domHit = c.dayOfMonth.has(dom);
  const dowHit = c.dayOfWeek.has(dow);
  // Vixie cron: if neither dom nor dow is '*', either matching is enough.
  if (!c.domStar && !c.dowStar) return domHit || dowHit;
  if (!c.domStar) return domHit;
  if (!c.dowStar) return dowHit;
  return true;
}

/** Approximate period length (s) for a cron expression — used as a default
 *  grace window heuristic. Computes the average gap between the next 5 runs. */
export function approximatePeriodSeconds(expr: string, fromMs: number = Date.now()): number {
  const samples: number[] = [];
  let t = fromMs;
  for (let i = 0; i < 6; i++) {
    t = nextRun(expr, t);
    samples.push(t);
  }
  let totalGap = 0;
  for (let i = 1; i < samples.length; i++) totalGap += samples[i] - samples[i - 1];
  return Math.round(totalGap / (samples.length - 1) / 1000);
}
