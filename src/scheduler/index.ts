// Scheduler Worker entry. Owns Durable Object class definitions, the cron
// triggers (per-minute alarm-arming, nightly rollup, nightly prune), and the
// notifications queue consumer. Deployed separately from the Astro app.

export { MonitorScheduler } from '~/do/MonitorScheduler';
export { HeartbeatTracker } from '~/do/HeartbeatTracker';

import { dispatchNotification } from '~/lib/notify';

const ROLLUP_HOUR_CRON = '5 0 * * *';
const PRUNE_HOUR_CRON = '15 0 * * *';

export default {
  // Local-dev status endpoint. The scheduler Worker normally has no fetch
  // handler — its only externally-triggered surface is the cron handler
  // (via `/__scheduled?cron=...` when started with `--test-scheduled`) and
  // the queue consumer. This handler exists so `curl localhost:8788/` shows
  // "yes I'm alive" instead of "no fetch handler registered".
  async fetch(req: Request, env: Cloudflare.Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/status') {
      return Response.json({
        worker: 'uptime-scarecrow-scheduler',
        version: env.APP_VERSION,
        bindings: {
          DB:                !!env.DB,
          CACHE:             !!env.CACHE,
          MONITOR_SCHEDULER: !!env.MONITOR_SCHEDULER,
          HEARTBEAT_TRACKER: !!env.HEARTBEAT_TRACKER,
          NOTIFY_QUEUE:      !!(env as unknown as { NOTIFY_QUEUE?: unknown }).NOTIFY_QUEUE,
          SEND_EMAIL:        !!env.SEND_EMAIL,
        },
        crons: {
          arm:    '* * * * *   — re-arm DO alarms (safety net)',
          rollup: '5 0 * * *   — rollupYesterday → check_daily',
          prune:  '15 0 * * *  — pruneRecentChecks (drop >8d)',
        },
        triggers_endpoint: '/__scheduled?cron=*+*+*+*+*  (only when --test-scheduled is passed)',
        note: 'Cron triggers do not auto-fire in wrangler dev. DO alarms DO fire on schedule.',
      }, { headers: { 'cache-control': 'no-store' } });
    }
    return new Response('not found', { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Cloudflare.Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === ROLLUP_HOUR_CRON) {
      ctx.waitUntil(rollupYesterday(env));
      return;
    }
    if (event.cron === PRUNE_HOUR_CRON) {
      ctx.waitUntil(pruneRecentChecks(env));
      return;
    }
    // default: per-minute tick — keep DO alarms armed.
    ctx.waitUntil(armAlarms(env));
  },

  async queue(batch: MessageBatch<NotifyMessage>, env: Cloudflare.Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await dispatchQueueMessage(env, msg.body);
        msg.ack();
      } catch (err) {
        console.error('notification dispatch failed', (err as Error).message);
        msg.retry({ delaySeconds: 30 });
      }
    }
  },
};

async function armAlarms(env: Cloudflare.Env): Promise<void> {
  const { results } = await env.DB
    .prepare(`SELECT id, type FROM monitor WHERE paused = 0`)
    .all<{ id: number; type: 'http' | 'heartbeat' }>();

  for (const r of results) {
    const ns = r.type === 'http' ? env.MONITOR_SCHEDULER : env.HEARTBEAT_TRACKER;
    const stub = ns.get(ns.idFromName(`m:${r.id}`));
    try {
      await stub.fetch('https://do/ensure', {
        method: 'POST',
        body: JSON.stringify({ monitor_id: r.id }),
        headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      console.warn(`ensure ${r.type}:${r.id} failed`, (err as Error).message);
    }
  }
}

/**
 * Roll yesterday's `recent_check` rows into one `check_daily` row per monitor.
 * Idempotent — uses INSERT OR REPLACE on (monitor_id, day).
 *
 * Runs at 00:05 UTC. The 8-day buffer in `recent_check` means we always still
 * have yesterday's full data when this fires, even if the cron is delayed.
 */
async function rollupYesterday(env: Cloudflare.Env): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const today = Math.floor(nowSec / 86400);
  const day = today - 1;
  const dayStart = day * 86400;
  const dayEnd = (day + 1) * 86400;

  // Aggregate per monitor for yesterday. Latency percentiles use SQLite
  // PERCENTILE_CONT-equivalent via ordered ROW_NUMBER() in a subquery — D1
  // doesn't ship with the percentile aggregate, so we compute it ourselves.
  const aggSql = `
    WITH ranked AS (
      SELECT monitor_id, latency_ms, status,
             ROW_NUMBER() OVER (PARTITION BY monitor_id ORDER BY COALESCE(latency_ms, 0)) AS rn,
             COUNT(*) OVER (PARTITION BY monitor_id) AS n
        FROM recent_check
       WHERE started_at >= ? AND started_at < ?
    )
    SELECT
      monitor_id,
      COUNT(*)                                               AS checks,
      SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)         AS ups,
      SUM(CASE WHEN status IN ('fail','timeout') THEN 1 ELSE 0 END) AS downs,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)      AS errors,
      MIN(CASE WHEN rn = MAX(1, CAST(n*0.50 AS INTEGER)) THEN latency_ms END) AS p50_ms,
      MIN(CASE WHEN rn = MAX(1, CAST(n*0.95 AS INTEGER)) THEN latency_ms END) AS p95_ms,
      MIN(CASE WHEN rn = MAX(1, CAST(n*0.99 AS INTEGER)) THEN latency_ms END) AS p99_ms,
      MAX(latency_ms)                                        AS max_ms,
      MIN(NULLIF(latency_ms, NULL))                          AS dummy
    FROM ranked
    GROUP BY monitor_id
  `;

  // SQLite's MIN with conditional gets noisy across versions; do percentile
  // selection in two steps to keep the query portable.
  const { results: counts } = await env.DB.prepare(`
    SELECT monitor_id,
           COUNT(*)                                               AS checks,
           SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)         AS ups,
           SUM(CASE WHEN status IN ('fail','timeout') THEN 1 ELSE 0 END) AS downs,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)      AS errors,
           MAX(latency_ms)                                        AS max_ms,
           MIN(started_at)                                        AS first_at,
           MAX(started_at)                                        AS last_at
      FROM recent_check
     WHERE started_at >= ? AND started_at < ?
     GROUP BY monitor_id
  `).bind(dayStart, dayEnd).all<{
    monitor_id: number; checks: number; ups: number; downs: number; errors: number;
    max_ms: number | null; first_at: number; last_at: number;
  }>();

  // Closed incidents that intersected this UTC day → down_seconds + count.
  const { results: incRows } = await env.DB.prepare(`
    SELECT monitor_id,
           SUM(MIN(COALESCE(resolved_at, ?), ?) - MAX(opened_at, ?)) AS down_seconds,
           COUNT(*) AS incident_count
      FROM incident
     WHERE opened_at < ?
       AND COALESCE(resolved_at, ?) > ?
     GROUP BY monitor_id
  `).bind(dayEnd, dayEnd, dayStart, dayEnd, dayEnd, dayStart).all<{
    monitor_id: number; down_seconds: number | null; incident_count: number;
  }>();
  const incByMon = new Map<number, { down_seconds: number; incident_count: number }>();
  for (const r of incRows) {
    incByMon.set(r.monitor_id, {
      down_seconds: r.down_seconds ?? 0,
      incident_count: r.incident_count ?? 0,
    });
  }

  for (const c of counts) {
    const lats = await env.DB.prepare(`
      SELECT latency_ms FROM recent_check
       WHERE monitor_id = ? AND started_at >= ? AND started_at < ? AND latency_ms IS NOT NULL
       ORDER BY latency_ms
    `).bind(c.monitor_id, dayStart, dayEnd).all<{ latency_ms: number }>();
    const arr = lats.results.map((r) => r.latency_ms);
    const pick = (p: number): number | null => {
      if (arr.length === 0) return null;
      const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil(p * arr.length) - 1));
      return arr[idx];
    };

    const inc = incByMon.get(c.monitor_id) ?? { down_seconds: 0, incident_count: 0 };
    const uptimePct = c.checks > 0 ? (100 * c.ups) / c.checks : 0;

    await env.DB.prepare(`
      INSERT INTO check_daily (
        monitor_id, day,
        checks, ups, downs, errors,
        uptime_pct, down_seconds, incident_count,
        p50_ms, p95_ms, p99_ms, max_ms,
        first_at, last_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(monitor_id, day) DO UPDATE SET
        checks         = excluded.checks,
        ups            = excluded.ups,
        downs          = excluded.downs,
        errors         = excluded.errors,
        uptime_pct     = excluded.uptime_pct,
        down_seconds   = excluded.down_seconds,
        incident_count = excluded.incident_count,
        p50_ms         = excluded.p50_ms,
        p95_ms         = excluded.p95_ms,
        p99_ms         = excluded.p99_ms,
        max_ms         = excluded.max_ms,
        first_at       = excluded.first_at,
        last_at        = excluded.last_at
    `).bind(
      c.monitor_id, day,
      c.checks, c.ups, c.downs, c.errors,
      uptimePct, inc.down_seconds, inc.incident_count,
      pick(0.50), pick(0.95), pick(0.99), c.max_ms,
      c.first_at, c.last_at,
    ).run();
  }

  console.log(`rollup day=${day}: ${counts.length} monitors`);
  // suppress unused linter on the abandoned `aggSql` literal — kept for future SQL exploration.
  void aggSql;
}

async function pruneRecentChecks(env: Cloudflare.Env): Promise<void> {
  // 8-day window per docs/specs/timeseries.md. Runs after the rollup so we
  // never drop a row that hasn't been promoted to check_daily yet.
  const cutoff = Math.floor(Date.now() / 1000) - 8 * 86400;
  const res = await env.DB.prepare(`DELETE FROM recent_check WHERE started_at < ?`).bind(cutoff).run();
  console.log(`prune cutoff=${cutoff}: ${(res.meta as { changes?: number })?.changes ?? 0} rows`);
}

async function dispatchQueueMessage(env: Cloudflare.Env, msg: NotifyMessage): Promise<void> {
  const monitor = await env.DB
    .prepare(`SELECT id, name, config FROM monitor WHERE id = ?`)
    .bind(msg.monitor_id)
    .first<{ id: number; name: string; config: string }>();
  if (!monitor) return;

  let monitor_url: string | undefined;
  try { monitor_url = JSON.parse(monitor.config)?.url; } catch { /* heartbeat */ }

  const cause = ((msg.payload as { outcome?: { error_msg?: string } } | undefined)?.outcome?.error_msg) ?? 'Check failed';

  await dispatchNotification(env, {
    kind: msg.kind,
    monitor_id: monitor.id,
    incident_id: msg.incident_id ?? null,
    monitor_name: monitor.name,
    monitor_url,
    cause,
    app_base_url: env.APP_BASE_URL ?? 'http://localhost:4321',
  });
}
