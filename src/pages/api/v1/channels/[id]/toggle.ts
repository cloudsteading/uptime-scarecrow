import type { APIRoute } from 'astro';
import { getChannel, setChannelEnabled } from '~/lib/channels';
import { logAudit } from '~/lib/db';

export const POST: APIRoute = async (ctx) => {
  const me = ctx.locals.user;
  if (!me) return new Response('Unauthorized', { status: 401 });
  const id = Number(ctx.params.id);
  if (!Number.isFinite(id)) return new Response('Bad id', { status: 400 });
  const ch = await getChannel(id);
  if (!ch) return new Response('Not found', { status: 404 });
  await setChannelEnabled(id, !ch.enabled);
  await logAudit({
    actor_user_id: me.id || null,
    actor_email: me.email,
    action: ch.enabled ? 'channel.disable' : 'channel.enable',
    target: `channel:${id}`,
    ip: ctx.clientAddress,
  });
  return new Response(null, { status: 303, headers: { Location: '/settings' } });
};
