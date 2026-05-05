// One Durable Object per HTTP monitor. Owns its own alarm; the alarm fires the
// check at the configured interval. Cron tick worker calls /ensure to (re-)arm
// alarms after deploys.

import { runHttpCheck } from '~/lib/checks';
import type { HttpMonitorConfig, MonitorRow } from '~/lib/db';
import { db } from '~/lib/db';
import { applyCheckOutcome } from '~/lib/incidents';
import { nextRun } from '~/lib/cron';

type DoState = { monitor_id: number };

export class MonitorScheduler {
  state: DurableObjectState;
  env: Cloudflare.Env;

  constructor(state: DurableObjectState, env: Cloudflare.Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ensure') {
      const body = (await req.json().catch(() => null)) as { monitor_id?: number } | null;
      if (!body?.monitor_id) return new Response('monitor_id required', { status: 400 });
      await this.state.storage.put('mon', { monitor_id: body.monitor_id } satisfies DoState);
      const existing = await this.state.storage.getAlarm();
      if (!existing) {
        const monitor = await loadMonitor(body.monitor_id);
        if (monitor && !monitor.paused) {
          await this.state.storage.setAlarm(Date.now() + 1000);
        }
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/cancel') {
      await this.state.storage.deleteAlarm();
      return Response.json({ ok: true });
    }
    return new Response('Not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const meta = await this.state.storage.get<DoState>('mon');
    if (!meta) return;

    const monitor = await loadMonitor(meta.monitor_id);
    if (!monitor) return;
    if (monitor.paused) return;
    if (monitor.type !== 'http') return;

    let cfg: HttpMonitorConfig;
    try { cfg = JSON.parse(monitor.config); } catch {
      console.error(`MonitorScheduler ${meta.monitor_id}: bad config JSON`);
      await this.state.storage.setAlarm(Date.now() + monitor.interval_seconds * 1000);
      return;
    }

    try {
      const outcome = await runHttpCheck(cfg);
      await applyCheckOutcome({
        monitor_id: monitor.id,
        outcome,
        failure_threshold: monitor.failure_threshold,
        recovery_threshold: monitor.recovery_threshold,
      });
    } catch (err) {
      console.error(`MonitorScheduler ${meta.monitor_id} check failed:`, (err as Error).message);
    } finally {
      const next = computeNextHttpAlarm(monitor, cfg);
      await this.state.storage.setAlarm(next);
    }
  }
}

function computeNextHttpAlarm(monitor: MonitorRow, cfg: HttpMonitorConfig): number {
  if (cfg.cron_expression) {
    try {
      return nextRun(cfg.cron_expression, Date.now());
    } catch (err) {
      console.warn(`bad cron for monitor ${monitor.id}: ${(err as Error).message}; falling back to interval`);
    }
  }
  return Date.now() + monitor.interval_seconds * 1000;
}

async function loadMonitor(id: number): Promise<MonitorRow | null> {
  return (await db().prepare(`SELECT * FROM monitor WHERE id = ?`).bind(id).first<MonitorRow>()) ?? null;
}
