import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getChannel } from '~/lib/channels';
import { logAudit } from '~/lib/db';
import { dispatchNotification } from '~/lib/notify';

export const POST: APIRoute = async (ctx) => {
  const me = ctx.locals.user;
  if (!me) return new Response('Unauthorized', { status: 401 });
  const id = Number(ctx.params.id);
  if (!Number.isFinite(id)) return new Response('Bad id', { status: 400 });
  const ch = await getChannel(id);
  if (!ch) return new Response('Not found', { status: 404 });

  const summary = await dispatchNotification(env, {
    kind: 'test',
    monitor_id: null,
    monitor_name: `[test] channel #${id} (${ch.name})`,
    test_message: `Test from /settings — triggered by ${me.email}`,
    app_base_url: env.APP_BASE_URL ?? new URL(ctx.request.url).origin,
  }, { restrictChannelIds: [id] });

  await logAudit({
    actor_user_id: me.id || null,
    actor_email: me.email,
    action: 'channel.test',
    target: `channel:${id}`,
    payload: summary.attempts,
    ip: ctx.clientAddress,
  });

  const a = summary.attempts[0];
  const flash = a
    ? (a.status === 'sent'
        ? `Test sent to ${ch.type} channel "${ch.name}" in ${a.latency_ms ?? '?'}ms`
        : `Test ${a.status} for "${ch.name}": ${a.error ?? 'unknown error'}`)
    : 'No delivery attempt recorded';
  const kind = a?.status === 'sent' ? 'ok' : 'err';

  return new Response(null, {
    status: 303,
    headers: { Location: `/settings?flash=${encodeURIComponent(flash)}&flash_kind=${kind}` },
  });
};
