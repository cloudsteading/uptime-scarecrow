import type { APIRoute } from 'astro';
import { setAlertEmail, logAudit } from '~/lib/db';
import { flashRedirect } from '~/lib/flash';

export const POST: APIRoute = async (ctx) => {
  const me = ctx.locals.user;
  if (!me) return new Response('Unauthorized', { status: 401 });
  const id = Number(ctx.params.id);
  if (!Number.isFinite(id)) return new Response('Bad id', { status: 400 });

  const form = await ctx.request.formData();
  const on = form.get('on') === '1';

  await setAlertEmail(id, on);
  await logAudit({
    actor_user_id: me.id || null,
    actor_email: me.email,
    action: on ? 'user.alert_email.on' : 'user.alert_email.off',
    target: `user:${id}`,
    ip: ctx.clientAddress,
  });

  return flashRedirect(ctx, '/admin/settings', 'Alert preference saved');
};
