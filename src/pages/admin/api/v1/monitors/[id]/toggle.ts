import type { APIRoute } from 'astro';
import { getMonitor, setPaused } from '~/lib/monitors';
import { logAudit } from '~/lib/db';

export const POST: APIRoute = async (ctx) => {
  const user = ctx.locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });
  const id = Number(ctx.params.id);
  if (!Number.isFinite(id)) return new Response('Bad id', { status: 400 });

  const m = await getMonitor(id);
  if (!m) return new Response('Not found', { status: 404 });
  await setPaused(id, !m.paused);
  await logAudit({
    actor_user_id: user.id || null,
    actor_email: user.email,
    action: m.paused ? 'monitor.resume' : 'monitor.pause',
    target: `monitor:${id}`,
    ip: ctx.clientAddress,
  });
  return new Response(null, { status: 303, headers: { Location: `/admin/monitor/${id}` } });
};
