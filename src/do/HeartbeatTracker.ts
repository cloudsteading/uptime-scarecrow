// One DO per heartbeat monitor. /ping resets the alarm; alarm firing = missed
// ping → incident. Single-tenant — no workspace scoping.

import { db } from '~/lib/db';
import { applyCheckOutcome } from '~/lib/incidents';
import type { HeartbeatMonitorConfig, MonitorRow } from '~/lib/db';
import { nextRun } from '~/lib/cron';

type DoState = { monitor_id: number; last_ping_at: number | null };

export class HeartbeatTracker {
  state: DurableObjectState;
  env: Cloudflare.Env;

  constructor(state: DurableObjectState, env: Cloudflare.Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/ping') {
      const body = (await req.json().catch(() => null)) as { monitor_id?: number; outcome?: 'ok' | 'fail' } | null;
      if (!body?.monitor_id) return new Response('monitor_id required', { status: 400 });
      const monitor = await loadMonitor(body.monitor_id);
      if (!monitor) return new Response('not found', { status: 404 });

      await this.state.storage.put('mon', {
        monitor_id: body.monitor_id,
        last_ping_at: Math.floor(Date.now() / 1000),
      } satisfies DoState);

      const outcome = body.outcome === 'fail'
        ? { status: 'fail' as const, latency_ms: 0, error_kind: 'job_reported_failure', error_msg: 'cron job reported failure via /fail' }
        : { status: 'ok' as const, latency_ms: 0 };

      await applyCheckOutcome({
        monitor_id: monitor.id,
        outcome,
        failure_threshold: monitor.failure_threshold,
        recovery_threshold: monitor.recovery_threshold,
      });

      await scheduleNextAlarm(this.state, monitor);
      return Response.json({ ok: true });
    }

    if (url.pathname === '/ensure') {
      const body = (await req.json().catch(() => null)) as { monitor_id?: number } | null;
      if (!body?.monitor_id) return new Response('monitor_id required', { status: 400 });
      const existing = await this.state.storage.get<DoState>('mon');
      if (!existing) {
        await this.state.storage.put('mon', { monitor_id: body.monitor_id, last_ping_at: null } satisfies DoState);
      }
      const a = await this.state.storage.getAlarm();
      if (!a) {
        const monitor = await loadMonitor(body.monitor_id);
        if (monitor && !monitor.paused) await scheduleNextAlarm(this.state, monitor);
      }
      return Response.json({ ok: true });
    }

    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const meta = await this.state.storage.get<DoState>('mon');
    if (!meta) return;
    const monitor = await loadMonitor(meta.monitor_id);
    if (!monitor || monitor.paused) return;

    await applyCheckOutcome({
      monitor_id: monitor.id,
      outcome: {
        status: 'fail',
        latency_ms: 0,
        error_kind: 'missed_heartbeat',
        error_msg: `No ping in expected window (interval/cron + grace)`,
      },
      failure_threshold: 1,
      recovery_threshold: 1,
    });

    await scheduleNextAlarm(this.state, monitor);
  }
}

function parseHeartbeatConfig(monitor: MonitorRow): HeartbeatMonitorConfig {
  try { return JSON.parse(monitor.config); } catch { return { token_hash: '' }; }
}

async function scheduleNextAlarm(state: DurableObjectState, monitor: MonitorRow): Promise<void> {
  const cfg = parseHeartbeatConfig(monitor);
  const now = Date.now();
  let dueAt: number;
  if (cfg.cron_expression) {
    try {
      dueAt = nextRun(cfg.cron_expression, now) + monitor.grace_seconds * 1000;
    } catch (err) {
      console.warn(`bad cron for monitor ${monitor.id}: ${(err as Error).message}; falling back to interval`);
      dueAt = now + (monitor.interval_seconds + monitor.grace_seconds) * 1000;
    }
  } else {
    dueAt = now + (monitor.interval_seconds + monitor.grace_seconds) * 1000;
  }
  await state.storage.setAlarm(dueAt);
}

async function loadMonitor(id: number): Promise<MonitorRow | null> {
  return (await db().prepare(`SELECT * FROM monitor WHERE id = ?`).bind(id).first<MonitorRow>()) ?? null;
}
