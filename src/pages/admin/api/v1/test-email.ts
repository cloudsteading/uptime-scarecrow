import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { logAudit } from '~/lib/db';

export const POST: APIRoute = async (ctx) => {
  const me = ctx.locals.user;
  if (!me) return new Response('Unauthorized', { status: 401 });

  const to = me.email;
  let flash: string;
  let kind: 'ok' | 'err' = 'ok';

  if (!env.SEND_EMAIL) {
    flash = 'No SEND_EMAIL binding — check wrangler.jsonc and that you started wrangler dev (not just astro dev)';
    kind = 'err';
  } else if (!env.EMAIL_FROM) {
    flash = 'EMAIL_FROM secret is not set — wrangler secret put EMAIL_FROM';
    kind = 'err';
  } else {
    try {
      await env.SEND_EMAIL.send({
        to,
        from: env.EMAIL_FROM,
        subject: '[Uptime Scarecrow] Test alert',
        text: `This is a test alert from Uptime Scarecrow. If you received this, alerting is wired up correctly.\n\nFrom ${env.APP_BASE_URL ?? '(no APP_BASE_URL set)'}\n`,
        html: `<p>This is a test alert from <strong>Uptime Scarecrow</strong>. If you received this, alerting is wired up correctly.</p><p style="color:#64748b">From ${env.APP_BASE_URL ?? '(no APP_BASE_URL set)'}</p>`,
      });
      flash = `Test email sent to ${to} via Cloudflare Email Service`;
    } catch (err) {
      flash = `Email send failed: ${(err as Error).message}`;
      kind = 'err';
    }
  }

  await logAudit({
    actor_user_id: me.id || null,
    actor_email: me.email,
    action: 'email.test',
    target: to,
    payload: { ok: kind === 'ok', flash },
    ip: ctx.clientAddress,
  });

  return new Response(null, {
    status: 303,
    headers: {
      Location: `/admin/settings?flash=${encodeURIComponent(flash)}&flash_kind=${kind}`,
    },
  });
};
