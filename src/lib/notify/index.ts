// Notification dispatcher. Walks all enabled channels + the legacy
// per-user `alert_email` toggle, hands each one to the appropriate adapter,
// and writes the outcome to `notification_log` so the incident detail page
// can show "we tried to tell you at 12:34, slack succeeded, pagerduty 503'd."

import type { ChannelAdapter, ChannelRow, ChannelType, DeliveryAttempt, Notification } from './types';
import { emailChannel } from './email';
import { slackChannel } from './slack';
import { discordChannel } from './discord';
import { webhookChannel } from './webhook';

const ADAPTERS: Record<ChannelType, ChannelAdapter | undefined> = {
  email:    emailChannel,
  slack:    slackChannel,
  discord:  discordChannel,
  webhook:  webhookChannel,
  pagerduty: undefined,  // v0.2
  telegram:  undefined,  // v0.2
};

export type DispatchSummary = {
  attempts: DeliveryAttempt[];
};

/**
 * Send a notification across every enabled channel + every alert_email user.
 * Returns the per-attempt log; also persists each attempt to notification_log.
 *
 * If `restrictChannelIds` is given, only those channel rows are dispatched
 * (used by the per-channel "test" button in /settings).
 */
export async function dispatchNotification(
  env: Cloudflare.Env,
  n: Notification,
  opts: { restrictChannelIds?: number[] } = {},
): Promise<DispatchSummary> {
  const attempts: DeliveryAttempt[] = [];

  // Channel-row recipients (everything except the per-user email fallback)
  let channels: ChannelRow[] = [];
  if (opts.restrictChannelIds && opts.restrictChannelIds.length > 0) {
    const ph = opts.restrictChannelIds.map(() => '?').join(',');
    const r = await env.DB.prepare(
      `SELECT id, type, name, config, enabled, created_at FROM notification_channel
       WHERE id IN (${ph})`,
    ).bind(...opts.restrictChannelIds).all<ChannelRow>();
    channels = r.results;
  } else {
    const r = await env.DB.prepare(
      `SELECT id, type, name, config, enabled, created_at FROM notification_channel
       WHERE enabled = 1`,
    ).all<ChannelRow>();
    channels = r.results;
  }

  for (const ch of channels) {
    const adapter = ADAPTERS[ch.type];
    if (!adapter) {
      attempts.push({ channel_id: ch.id, channel_type: ch.type, recipient: '', status: 'skipped', error: `${ch.type} adapter not implemented yet` });
      continue;
    }
    let cfg: { url?: string; address?: string; recipient?: string };
    try { cfg = JSON.parse(ch.config); } catch { cfg = {}; }
    const recipient = ch.type === 'email'
      ? (cfg.address ?? '')
      : (cfg.url ?? cfg.recipient ?? '');
    if (!recipient) {
      attempts.push({ channel_id: ch.id, channel_type: ch.type, recipient: '', status: 'failed', error: 'channel config missing destination' });
      continue;
    }
    attempts.push(await adapter.deliver(env, ch, recipient, n));
  }

  // Email fallback / co-recipient: every user with alert_email = 1.
  // Only fires when there's NO explicit email channel configured AND we're
  // not in restrict-to-channel-ids mode (e.g. a per-channel test).
  const hasExplicitEmailChannel = channels.some((c) => c.type === 'email');
  if (!opts.restrictChannelIds && !hasExplicitEmailChannel) {
    const { results: users } = await env.DB
      .prepare(`SELECT email FROM user WHERE alert_email = 1`)
      .all<{ email: string }>();
    for (const u of users) {
      attempts.push(await emailChannel.deliver(env, null, u.email, n));
    }
  }

  // Persist every attempt.
  if (attempts.length > 0) {
    const stmts = attempts.map((a) =>
      env.DB.prepare(
        `INSERT INTO notification_log (monitor_id, incident_id, channel_id, kind, channel_type, recipient, status, latency_ms, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        n.monitor_id,
        n.incident_id ?? null,
        a.channel_id,
        n.kind,
        a.channel_type,
        a.recipient || null,
        a.status,
        a.latency_ms ?? null,
        a.error ?? null,
      ),
    );
    await env.DB.batch(stmts);
  }

  if (attempts.length === 0) {
    console.warn(`[notify] no recipients for ${n.kind} on monitor ${n.monitor_id} — toggle a user on at /settings or add a channel.`);
  }

  return { attempts };
}
