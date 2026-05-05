import { env } from 'cloudflare:workers';

export function db(): D1Database {
  const d = env.DB;
  if (!d) throw new Error('D1 binding DB missing');
  return d;
}

export type UserRow = {
  id: number;
  email: string;
  display_name: string | null;
  is_admin: number;
  alert_email: number;
  created_at: number;
  last_seen_at: number | null;
};

export type MonitorType = 'http' | 'heartbeat';

export type HttpMonitorConfig = {
  url: string;
  method: 'GET' | 'HEAD' | 'POST';
  expected_codes: number[];
  timeout_ms: number;
  headers?: Record<string, string>;
  body?: string;
  keyword_present?: string;
  keyword_absent?: string;
  /** When set, schedule is driven by cron (UTC). interval_seconds is treated
   *  as the average period for display only. */
  cron_expression?: string;
};

export type HeartbeatMonitorConfig = {
  token_hash: string;
  /** When set, schedule is driven by cron. interval_seconds becomes ignored. */
  cron_expression?: string;
};

export type MonitorRow = {
  id: number;
  type: MonitorType;
  name: string;
  config: string;
  interval_seconds: number;
  grace_seconds: number;
  paused: number;
  failure_threshold: number;
  recovery_threshold: number;
  created_at: number;
  created_by: number | null;
};

export type MonitorStateRow = {
  monitor_id: number;
  status: 'up' | 'down' | 'paused' | 'unknown';
  consecutive_failures: number;
  consecutive_successes: number;
  last_check_at: number | null;
  last_status_change_at: number | null;
  current_incident_id: number | null;
};

export type RecentCheckRow = {
  id: number;
  monitor_id: number;
  started_at: number;
  status: 'ok' | 'fail' | 'timeout' | 'error';
  latency_ms: number | null;
  http_code: number | null;
  error_kind: string | null;
  error_msg: string | null;
};

export function isAllowedEmail(email: string, allowList: string | undefined): boolean {
  if (!allowList || !allowList.trim()) return true; // no list configured → trust Access policy
  const set = new Set(
    allowList.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  );
  return set.has(email.toLowerCase());
}

/**
 * Upsert a user row on each Access-authenticated request. Idempotent.
 * The first user to sign in (or anyone in BOOTSTRAP_ADMIN_EMAILS) is admin.
 */
export async function upsertUser(
  email: string,
  bootstrapAdminEmails: string | undefined,
): Promise<UserRow> {
  const d = db();
  const isBootstrapAdmin =
    !!bootstrapAdminEmails &&
    bootstrapAdminEmails
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .includes(email.toLowerCase());

  // First-user-is-admin: if no rows exist, the inserter is admin.
  const haveAny = await d.prepare(`SELECT 1 FROM user LIMIT 1`).first();
  const initialAdmin = haveAny ? (isBootstrapAdmin ? 1 : 0) : 1;
  // Admins get alerts on by default; non-admins must opt in from /settings.
  const initialAlertEmail = initialAdmin;

  await d
    .prepare(`INSERT INTO user (email, is_admin, alert_email) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING`)
    .bind(email, initialAdmin, initialAlertEmail)
    .run();

  if (isBootstrapAdmin) {
    await d
      .prepare(`UPDATE user SET is_admin = 1, alert_email = 1 WHERE email = ?`)
      .bind(email)
      .run();
  }

  await d
    .prepare(`UPDATE user SET last_seen_at = unixepoch() WHERE email = ?`)
    .bind(email)
    .run();

  const row = await d
    .prepare(
      `SELECT id, email, display_name, is_admin, alert_email, created_at, last_seen_at
         FROM user WHERE email = ?`,
    )
    .bind(email)
    .first<UserRow>();
  if (!row) throw new Error('user upsert failed');
  return row;
}

export async function listUsers(): Promise<UserRow[]> {
  const { results } = await db()
    .prepare(
      `SELECT id, email, display_name, is_admin, alert_email, created_at, last_seen_at
         FROM user ORDER BY created_at`,
    )
    .all<UserRow>();
  return results;
}

export async function setAlertEmail(userId: number, on: boolean): Promise<void> {
  await db()
    .prepare(`UPDATE user SET alert_email = ? WHERE id = ?`)
    .bind(on ? 1 : 0, userId)
    .run();
}

export async function listAlertRecipients(): Promise<string[]> {
  const { results } = await db()
    .prepare(`SELECT email FROM user WHERE alert_email = 1`)
    .all<{ email: string }>();
  return results.map((r) => r.email);
}

export async function logAudit(args: {
  actor_user_id: number | null;
  actor_email: string | null;
  action: string;
  target?: string | null;
  payload?: unknown;
  ip?: string | null;
}): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO audit_log (actor_user_id, actor_email, action, target, payload, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.actor_user_id,
      args.actor_email,
      args.action,
      args.target ?? null,
      args.payload == null ? null : JSON.stringify(args.payload),
      args.ip ?? null,
    )
    .run();
}
