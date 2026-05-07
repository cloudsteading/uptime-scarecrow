import type { APIRoute } from 'astro';
import { deleteChannel } from '~/lib/channels';
import { logAudit } from '~/lib/db';
import { flashRedirect } from '~/lib/flash';

export const POST: APIRoute = async (ctx) => {
  const me = ctx.locals.user;
  if (!me) return new Response('Unauthorized', { status: 401 });
  const id = Number(ctx.params.id);
  if (!Number.isFinite(id)) return new Response('Bad id', { status: 400 });

  const ok = await deleteChannel(id);
  if (!ok) return new Response('Not found', { status: 404 });

  await logAudit({
    actor_user_id: me.id || null,
    actor_email: me.email,
    action: 'channel.delete',
    target: `channel:${id}`,
    ip: ctx.clientAddress,
  });

  return flashRedirect(ctx, '/admin/settings', 'Channel deleted');
};
