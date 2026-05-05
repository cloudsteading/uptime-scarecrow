import type { APIRoute } from 'astro';
import { updateHttpMonitor, updateHeartbeatMonitor } from '~/lib/monitors';
import { logAudit } from '~/lib/db';
import { validateCron } from '~/lib/cron';

function fail(id: number, msg: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `/monitor/${id}/edit?error=${encodeURIComponent(msg)}` },
  });
}

export const POST: APIRoute = async (ctx) => {
  const me = ctx.locals.user;
  if (!me) return new Response('Unauthorized', { status: 401 });
  const id = Number(ctx.params.id);
  if (!Number.isFinite(id)) return new Response('Bad id', { status: 400 });

  const form = await ctx.request.formData();
  const type = form.get('type');
  const name = String(form.get('name') ?? '').trim();
  if (!name) return fail(id, 'Name is required');

  const failure_threshold = Math.max(1, Math.min(20, Number(form.get('failure_threshold') ?? 2)));
  const recovery_threshold = Math.max(1, Math.min(20, Number(form.get('recovery_threshold') ?? 1)));

  if (type === 'http') {
    const url = String(form.get('url') ?? '').trim();
    const method = String(form.get('method') ?? 'GET') as 'GET' | 'HEAD' | 'POST';
    const timeout_ms = Number(form.get('timeout_ms') ?? 10_000);
    const keyword_present = String(form.get('keyword_present') ?? '').trim() || undefined;

    try { new URL(url); } catch { return fail(id, 'Invalid URL'); }
    if (!['GET', 'HEAD', 'POST'].includes(method)) return fail(id, 'Bad method');

    const kind = String(form.get('schedule_kind') ?? 'interval');
    let interval_seconds: number | undefined;
    let cron_expression: string | undefined;
    if (kind === 'cron') {
      cron_expression = String(form.get('cron_expression') ?? '').trim();
      if (!cron_expression) return fail(id, 'Cron expression required');
      const v = validateCron(cron_expression);
      if (!v.ok) return fail(id, `Invalid cron: ${v.error}`);
    } else {
      interval_seconds = Number(form.get('interval_seconds') ?? 300);
      if (![60, 300, 900, 3600].includes(interval_seconds)) return fail(id, 'Bad interval');
    }

    const ok = await updateHttpMonitor(id, {
      name, url, method, interval_seconds, cron_expression, timeout_ms, keyword_present,
      failure_threshold, recovery_threshold,
    });
    if (!ok) return new Response('Not found', { status: 404 });

    await logAudit({
      actor_user_id: me.id || null,
      actor_email: me.email,
      action: 'monitor.update',
      target: `monitor:${id}`,
      payload: { type: 'http', url, interval_seconds, cron_expression, timeout_ms },
      ip: ctx.clientAddress,
    });
    return new Response(null, { status: 303, headers: { Location: `/monitor/${id}` } });
  }

  if (type === 'heartbeat') {
    const grace_seconds = Number(form.get('grace_seconds') ?? 300);
    const kind = String(form.get('schedule_kind') ?? 'interval');
    let interval_seconds: number | undefined;
    let cron_expression: string | undefined;

    if (kind === 'cron') {
      cron_expression = String(form.get('cron_expression') ?? '').trim();
      if (!cron_expression) return fail(id, 'Cron expression required');
      const v = validateCron(cron_expression);
      if (!v.ok) return fail(id, `Invalid cron: ${v.error}`);
    } else {
      interval_seconds = Number(form.get('interval_seconds') ?? 3600);
      if (interval_seconds < 60 || interval_seconds > 30 * 86400) return fail(id, 'Interval out of range');
    }

    const ok = await updateHeartbeatMonitor(id, {
      name, interval_seconds, cron_expression, grace_seconds,
      failure_threshold, recovery_threshold,
    });
    if (!ok) return new Response('Not found', { status: 404 });

    await logAudit({
      actor_user_id: me.id || null,
      actor_email: me.email,
      action: 'monitor.update',
      target: `monitor:${id}`,
      payload: { type: 'heartbeat', interval_seconds, cron_expression, grace_seconds },
      ip: ctx.clientAddress,
    });
    return new Response(null, { status: 303, headers: { Location: `/monitor/${id}` } });
  }

  return fail(id, 'Unknown monitor type');
};
