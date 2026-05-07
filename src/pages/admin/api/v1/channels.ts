import type { APIRoute, APIContext } from 'astro';
import { createChannel } from '~/lib/channels';
import { logAudit } from '~/lib/db';
import type { ChannelType } from '~/lib/notify/types';

const ALLOWED_TYPES: ChannelType[] = ['email', 'slack', 'discord', 'webhook'];

const fail = (ctx: APIContext, msg: string) =>
  ctx.redirect(`/admin/settings?flash=${encodeURIComponent(msg)}&flash_kind=err`, 303);

export const POST: APIRoute = async (ctx) => {
  const me = ctx.locals.user;
  if (!me) return new Response('Unauthorized', { status: 401 });

  const form = await ctx.request.formData();
  const type = String(form.get('type') ?? '') as ChannelType;
  const name = String(form.get('name') ?? '').trim();
  if (!ALLOWED_TYPES.includes(type)) return fail(ctx, 'Unsupported channel type (v0.1: email/slack/discord/webhook)');
  if (!name) return fail(ctx, 'Channel name is required');

  let config: Record<string, unknown> = {};
  if (type === 'email') {
    const address = String(form.get('address') ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return fail(ctx, 'Invalid email address');
    config = { address };
  } else {
    const url = String(form.get('url') ?? '').trim();
    try { new URL(url); } catch { return fail(ctx, 'Invalid webhook URL'); }
    if (!/^https?:\/\//i.test(url)) return fail(ctx, 'Webhook URL must use http(s)');
    const secret = String(form.get('secret') ?? '').trim();
    config = secret ? { url, secret } : { url };
  }

  const id = await createChannel({ type, name, config });
  await logAudit({
    actor_user_id: me.id || null,
    actor_email: me.email,
    action: 'channel.create',
    target: `channel:${id}`,
    payload: { type, name },
    ip: ctx.clientAddress,
  });

  return ctx.redirect(
    `/admin/settings?flash=${encodeURIComponent(`Added ${type} channel "${name}"`)}`,
    303,
  );
};
