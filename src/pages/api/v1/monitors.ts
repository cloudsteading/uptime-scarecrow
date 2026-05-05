import type { APIRoute } from 'astro';
import { createHttpMonitor, createHeartbeatMonitor } from '~/lib/monitors';
import { logAudit } from '~/lib/db';
import { validateCron } from '~/lib/cron';
import { env } from 'cloudflare:workers';

function fail(redirectTo: string, msg: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `${redirectTo}&error=${encodeURIComponent(msg)}` },
  });
}

export const POST: APIRoute = async (ctx) => {
  const user = ctx.locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });

  const form = await ctx.request.formData();
  const type = form.get('type');
  const name = String(form.get('name') ?? '').trim();
  if (!name) return fail(`/monitor/new?type=${type}`, 'Name is required');

  if (type === 'http') {
    const url = String(form.get('url') ?? '').trim();
    const method = String(form.get('method') ?? 'GET') as 'GET' | 'HEAD' | 'POST';
    const timeout_ms = Number(form.get('timeout_ms') ?? 10_000);
    const keyword_present = String(form.get('keyword_present') ?? '').trim() || undefined;

    try { new URL(url); } catch { return fail('/monitor/new?type=http', 'Invalid URL'); }
    if (!['GET', 'HEAD', 'POST'].includes(method)) return fail('/monitor/new?type=http', 'Bad method');

    const kind = String(form.get('schedule_kind') ?? 'interval');
    let interval_seconds: number | undefined;
    let cron_expression: string | undefined;
    if (kind === 'cron') {
      cron_expression = String(form.get('cron_expression') ?? '').trim();
      if (!cron_expression) return fail('/monitor/new?type=http', 'Cron expression required');
      const v = validateCron(cron_expression);
      if (!v.ok) return fail('/monitor/new?type=http', `Invalid cron: ${v.error}`);
    } else {
      interval_seconds = Number(form.get('interval_seconds') ?? 300);
      if (![60, 300, 900, 3600].includes(interval_seconds)) return fail('/monitor/new?type=http', 'Bad interval');
    }

    const id = await createHttpMonitor({
      created_by: user.id || null,
      name, url, method, interval_seconds, cron_expression, timeout_ms, keyword_present,
    });
    await logAudit({
      actor_user_id: user.id || null,
      actor_email: user.email,
      action: 'monitor.create',
      target: `monitor:${id}`,
      payload: { type: 'http', url, interval_seconds, cron_expression },
      ip: ctx.clientAddress,
    });

    await ensureDO(env.MONITOR_SCHEDULER, id);

    return new Response(null, { status: 303, headers: { Location: `/monitor/${id}` } });
  }

  if (type === 'heartbeat') {
    const grace_seconds = Number(form.get('grace_seconds') ?? 300);
    const kind = String(form.get('schedule_kind') ?? 'interval');
    let interval_seconds: number | undefined;
    let cron_expression: string | undefined;

    if (kind === 'cron') {
      cron_expression = String(form.get('cron_expression') ?? '').trim();
      if (!cron_expression) return fail('/monitor/new?type=heartbeat', 'Cron expression required');
      const v = validateCron(cron_expression);
      if (!v.ok) return fail('/monitor/new?type=heartbeat', `Invalid cron: ${v.error}`);
    } else {
      interval_seconds = Number(form.get('interval_seconds') ?? 3600);
      if (interval_seconds < 60 || interval_seconds > 30 * 86400) {
        return fail('/monitor/new?type=heartbeat', 'Interval out of range');
      }
    }

    const { id, token } = await createHeartbeatMonitor({
      created_by: user.id || null,
      name, interval_seconds, cron_expression, grace_seconds,
    });
    await logAudit({
      actor_user_id: user.id || null,
      actor_email: user.email,
      action: 'monitor.create',
      target: `monitor:${id}`,
      payload: { type: 'heartbeat', interval_seconds, cron_expression, grace_seconds },
      ip: ctx.clientAddress,
    });

    await ensureDO(env.HEARTBEAT_TRACKER, id);

    // Show the token once. Pass via flash query — better than persisting it.
    return new Response(null, {
      status: 303,
      headers: { Location: `/monitor/${id}?new_token=${encodeURIComponent(token)}` },
    });
  }

  return fail('/monitor/new?type=http', 'Unknown monitor type');
};

async function ensureDO(ns: DurableObjectNamespace | undefined, id: number): Promise<void> {
  if (!ns) return;
  try {
    const stub = ns.get(ns.idFromName(`m:${id}`));
    await stub.fetch('https://do/ensure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monitor_id: id }),
    });
  } catch (err) {
    console.warn(`ensure DO m:${id} failed:`, (err as Error).message);
  }
}
