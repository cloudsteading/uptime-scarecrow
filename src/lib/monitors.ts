// Monitor CRUD. Single-tenant — no workspace scoping.

import { db } from '~/lib/db';
import type {
  HttpMonitorConfig,
  HeartbeatMonitorConfig,
  MonitorRow,
  MonitorStateRow,
} from '~/lib/db';

export type MonitorWithState = MonitorRow & {
  state: MonitorStateRow | null;
  parsed_config: HttpMonitorConfig | HeartbeatMonitorConfig | Record<string, unknown>;
};

function parseConfig(raw: string): MonitorWithState['parsed_config'] {
  try { return JSON.parse(raw); } catch { return {}; }
}

function rowToMonitor(r: MonitorRow & Partial<MonitorStateRow>): MonitorWithState {
  const state: MonitorStateRow | null = r.status
    ? {
        monitor_id: r.id,
        status: r.status as MonitorStateRow['status'],
        consecutive_failures: r.consecutive_failures ?? 0,
        consecutive_successes: r.consecutive_successes ?? 0,
        last_check_at: r.last_check_at ?? null,
        last_status_change_at: r.last_status_change_at ?? null,
        current_incident_id: r.current_incident_id ?? null,
      }
    : null;
  return {
    id: r.id, type: r.type, name: r.name, config: r.config,
    interval_seconds: r.interval_seconds, grace_seconds: r.grace_seconds,
    paused: r.paused, is_public: r.is_public ?? 0,
    failure_threshold: r.failure_threshold,
    recovery_threshold: r.recovery_threshold, created_at: r.created_at,
    created_by: r.created_by,
    state, parsed_config: parseConfig(r.config),
  };
}

export async function listMonitors(): Promise<MonitorWithState[]> {
  const { results } = await db()
    .prepare(
      `SELECT m.*,
              s.status, s.consecutive_failures, s.consecutive_successes,
              s.last_check_at, s.last_status_change_at, s.current_incident_id
         FROM monitor m
         LEFT JOIN monitor_state s ON s.monitor_id = m.id
        ORDER BY m.created_at DESC`,
    )
    .all<MonitorRow & Partial<MonitorStateRow>>();
  return results.map(rowToMonitor);
}

export async function getMonitor(id: number): Promise<MonitorWithState | null> {
  const r = await db()
    .prepare(
      `SELECT m.*, s.status, s.consecutive_failures, s.consecutive_successes,
              s.last_check_at, s.last_status_change_at, s.current_incident_id
         FROM monitor m
         LEFT JOIN monitor_state s ON s.monitor_id = m.id
        WHERE m.id = ?`,
    )
    .bind(id)
    .first<MonitorRow & Partial<MonitorStateRow>>();
  return r ? rowToMonitor(r) : null;
}

export type CreateHttpInput = {
  created_by: number | null;
  name: string;
  url: string;
  method: 'GET' | 'HEAD' | 'POST';
  /** Either interval_seconds OR cron_expression must be supplied. */
  interval_seconds?: number;
  cron_expression?: string;
  timeout_ms: number;
  keyword_present?: string;
  is_public?: boolean;
};

async function resolveScheduleSeconds(
  interval_seconds: number | undefined,
  cron_expression: string | undefined,
  fallback: number,
): Promise<number> {
  if (cron_expression) {
    try {
      const { approximatePeriodSeconds } = await import('~/lib/cron');
      return approximatePeriodSeconds(cron_expression);
    } catch {
      return fallback;
    }
  }
  return interval_seconds ?? fallback;
}

export async function createHttpMonitor(input: CreateHttpInput): Promise<number> {
  if (!input.interval_seconds && !input.cron_expression) {
    throw new Error('interval_seconds or cron_expression required');
  }
  const cfg: HttpMonitorConfig = {
    url: input.url,
    method: input.method,
    expected_codes: [200, 201, 202, 203, 204, 205, 206],
    timeout_ms: input.timeout_ms,
    keyword_present: input.keyword_present || undefined,
    cron_expression: input.cron_expression || undefined,
  };
  const intervalForRow = await resolveScheduleSeconds(input.interval_seconds, input.cron_expression, 300);
  const res = await db()
    .prepare(
      `INSERT INTO monitor (type, name, config, interval_seconds, grace_seconds, is_public, created_by)
       VALUES ('http', ?, ?, ?, 0, ?, ?)`,
    )
    .bind(input.name, JSON.stringify(cfg), intervalForRow, input.is_public ? 1 : 0, input.created_by)
    .run();
  const id = (res.meta as { last_row_id?: number })?.last_row_id;
  if (!id) throw new Error('monitor insert failed');
  await db()
    .prepare(`INSERT INTO monitor_state (monitor_id) VALUES (?) ON CONFLICT DO NOTHING`)
    .bind(id)
    .run();
  return id;
}

export type CreateHeartbeatInput = {
  created_by: number | null;
  name: string;
  /** Either interval_seconds OR cron_expression must be supplied. */
  interval_seconds?: number;
  cron_expression?: string;
  grace_seconds: number;
  is_public?: boolean;
};

export async function createHeartbeatMonitor(input: CreateHeartbeatInput): Promise<{ id: number; token: string }> {
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = b64url(tokenBytes);
  const tokenHash = await sha256Hex(token);

  if (!input.interval_seconds && !input.cron_expression) {
    throw new Error('interval_seconds or cron_expression required');
  }
  const cfg: HeartbeatMonitorConfig = {
    token_hash: tokenHash,
    cron_expression: input.cron_expression || undefined,
  };
  // For cron monitors we still store an interval_seconds (best-effort average
  // period) so list views can show a sensible "every X" string and as a fallback
  // if the cron parser ever rejects the stored expression.
  let intervalForRow = input.interval_seconds ?? 0;
  if (input.cron_expression && !intervalForRow) {
    try {
      const { approximatePeriodSeconds } = await import('~/lib/cron');
      intervalForRow = approximatePeriodSeconds(input.cron_expression);
    } catch { intervalForRow = 3600; }
  }

  const res = await db()
    .prepare(
      `INSERT INTO monitor (type, name, config, interval_seconds, grace_seconds, is_public, created_by)
       VALUES ('heartbeat', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(input.name, JSON.stringify(cfg), intervalForRow, input.grace_seconds, input.is_public ? 1 : 0, input.created_by)
    .run();
  const id = (res.meta as { last_row_id?: number })?.last_row_id;
  if (!id) throw new Error('monitor insert failed');
  await db()
    .prepare(`INSERT INTO monitor_state (monitor_id) VALUES (?) ON CONFLICT DO NOTHING`)
    .bind(id)
    .run();
  return { id, token };
}

export async function deleteMonitor(id: number): Promise<boolean> {
  const res = await db().prepare(`DELETE FROM monitor WHERE id = ?`).bind(id).run();
  return ((res.meta as { changes?: number })?.changes ?? 0) > 0;
}

export type UpdateHttpInput = {
  name: string;
  url: string;
  method: 'GET' | 'HEAD' | 'POST';
  interval_seconds?: number;
  cron_expression?: string;
  timeout_ms: number;
  keyword_present?: string;
  failure_threshold: number;
  recovery_threshold: number;
  is_public?: boolean;
};

export type UpdateHeartbeatInput = {
  name: string;
  interval_seconds?: number;
  cron_expression?: string;
  grace_seconds: number;
  failure_threshold: number;
  recovery_threshold: number;
  is_public?: boolean;
};

/**
 * Update an HTTP monitor in place. Preserves `created_at`, `created_by`, and
 * the `paused` flag (toggle that via /toggle). The DO re-reads the monitor
 * row at the next alarm fire, so config changes pick up automatically — no
 * explicit DO re-arming needed.
 */
export async function updateHttpMonitor(id: number, input: UpdateHttpInput): Promise<boolean> {
  const cur = await db().prepare(`SELECT type, config FROM monitor WHERE id = ?`).bind(id).first<{ type: string; config: string }>();
  if (!cur || cur.type !== 'http') return false;
  if (!input.interval_seconds && !input.cron_expression) {
    throw new Error('interval_seconds or cron_expression required');
  }

  const cfg: HttpMonitorConfig = {
    url: input.url,
    method: input.method,
    expected_codes: [200, 201, 202, 203, 204, 205, 206],
    timeout_ms: input.timeout_ms,
    keyword_present: input.keyword_present || undefined,
    cron_expression: input.cron_expression || undefined,
  };

  const intervalForRow = await resolveScheduleSeconds(input.interval_seconds, input.cron_expression, 300);

  const res = await db()
    .prepare(
      `UPDATE monitor
          SET name = ?, config = ?, interval_seconds = ?,
              failure_threshold = ?, recovery_threshold = ?,
              is_public = ?
        WHERE id = ?`,
    )
    .bind(
      input.name, JSON.stringify(cfg), intervalForRow,
      input.failure_threshold, input.recovery_threshold,
      input.is_public ? 1 : 0, id,
    )
    .run();
  return ((res.meta as { changes?: number })?.changes ?? 0) > 0;
}

/**
 * Update a heartbeat monitor in place. Preserves the existing `token_hash`
 * (rotation is a separate op).
 */
export async function updateHeartbeatMonitor(id: number, input: UpdateHeartbeatInput): Promise<boolean> {
  const cur = await db().prepare(`SELECT type, config FROM monitor WHERE id = ?`).bind(id).first<{ type: string; config: string }>();
  if (!cur || cur.type !== 'heartbeat') return false;

  if (!input.interval_seconds && !input.cron_expression) {
    throw new Error('interval_seconds or cron_expression required');
  }

  let curCfg: HeartbeatMonitorConfig = { token_hash: '' };
  try { curCfg = JSON.parse(cur.config); } catch { /* preserve empty */ }

  const cfg: HeartbeatMonitorConfig = {
    token_hash: curCfg.token_hash,
    cron_expression: input.cron_expression || undefined,
  };

  let intervalForRow = input.interval_seconds ?? 0;
  if (input.cron_expression && !intervalForRow) {
    try {
      const { approximatePeriodSeconds } = await import('~/lib/cron');
      intervalForRow = approximatePeriodSeconds(input.cron_expression);
    } catch { intervalForRow = 3600; }
  }

  const res = await db()
    .prepare(
      `UPDATE monitor
          SET name = ?, config = ?, interval_seconds = ?, grace_seconds = ?,
              failure_threshold = ?, recovery_threshold = ?,
              is_public = ?
        WHERE id = ?`,
    )
    .bind(
      input.name, JSON.stringify(cfg), intervalForRow, input.grace_seconds,
      input.failure_threshold, input.recovery_threshold,
      input.is_public ? 1 : 0, id,
    )
    .run();
  return ((res.meta as { changes?: number })?.changes ?? 0) > 0;
}

export async function setPaused(id: number, paused: boolean): Promise<void> {
  await db()
    .prepare(`UPDATE monitor SET paused = ? WHERE id = ?`)
    .bind(paused ? 1 : 0, id)
    .run();
  if (paused) {
    await db()
      .prepare(`UPDATE monitor_state SET status = 'paused' WHERE monitor_id = ?`)
      .bind(id)
      .run();
  }
}

export async function findHeartbeatMonitorByToken(token: string): Promise<MonitorRow | null> {
  const hash = await sha256Hex(token);
  const r = await db()
    .prepare(`SELECT * FROM monitor WHERE type = 'heartbeat' AND json_extract(config, '$.token_hash') = ?`)
    .bind(hash)
    .first<MonitorRow>();
  return r ?? null;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
