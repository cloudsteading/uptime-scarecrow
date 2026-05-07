import type { APIRoute } from 'astro';
import { deleteMonitor } from '~/lib/monitors';
import { logAudit } from '~/lib/db';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = async (ctx) => {
  const user = ctx.locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });
  const id = Number(ctx.params.id);
  if (!Number.isFinite(id)) return new Response('Bad id', { status: 400 });

  const ok = await deleteMonitor(id);
  if (!ok) return new Response('Not found', { status: 404 });

  await logAudit({
    actor_user_id: user.id || null,
    actor_email: user.email,
    action: 'monitor.delete',
    target: `monitor:${id}`,
    ip: ctx.clientAddress,
  });

  // Best-effort: cancel the DO alarm so it stops re-firing.
  for (const ns of [env.MONITOR_SCHEDULER, env.HEARTBEAT_TRACKER]) {
    if (!ns) continue;
    try {
      const stub = ns.get(ns.idFromName(`m:${id}`));
      await stub.fetch('https://do/cancel', { method: 'POST' });
    } catch (err) {
      console.warn(`cancel DO m:${id} failed:`, (err as Error).message);
    }
  }

  return new Response(null, { status: 303, headers: { Location: '/admin' } });
};
