// Email channel — sends via the Cloudflare Email Service binding.
// Used by both explicit `email`-type channel rows AND as a fallback
// for users with `user.alert_email = 1` when no email channels exist.

import type { ChannelAdapter, ChannelRow, DeliveryAttempt, Notification } from './types';

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shellHtml(inner: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f5f5f4;padding:24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;padding:24px;border:1px solid #e7e5e4">${inner}<hr style="margin:24px 0;border:0;border-top:1px solid #e7e5e4"><p style="margin:0;font:12px/1.5 system-ui;color:#94a3b8">scarecrow — built on Cloudflare</p></table></td></tr></table></body></html>`;
}

function renderEmail(n: Notification): { subject: string; text: string; html: string } {
  const link = n.app_base_url + (n.monitor_id ? `/monitor/${n.monitor_id}` : '');
  const linkBtn = `<p><a href="${escape(link)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#d97a2b;color:#fff;text-decoration:none;font:600 14px/1 system-ui">Open dashboard</a></p>`;

  if (n.kind === 'test') {
    return {
      subject: '[scarecrow] Test alert',
      text: `Test alert from scarecrow.\n\n${n.test_message ?? ''}\n\n${link}\n`,
      html: shellHtml(`
        <h1 style="margin:0 0 8px;font:600 20px/1.3 system-ui;color:#1c1f1e">Test alert</h1>
        <p style="margin:0 0 12px;font:14px/1.5 system-ui;color:#475569">${escape(n.test_message ?? 'If you received this, the email channel is wired up correctly.')}</p>
        ${linkBtn}
      `),
    };
  }

  if (n.kind === 'incident.open') {
    const url = n.monitor_url ? `<p style="margin:0 0 8px;color:#475569;font:14px/1.5 system-ui">${escape(n.monitor_url)}</p>` : '';
    const cause = n.cause ? `<div style="margin:16px 0;padding:12px 14px;border-radius:6px;background:#fef2f2;border-left:3px solid #a8392c;font:14px/1.5 system-ui;color:#7f1d1d">${escape(n.cause)}</div>` : '';
    return {
      subject: `[DOWN] ${n.monitor_name}`,
      text: `Monitor "${n.monitor_name}" is DOWN.\n\n${n.monitor_url ? `URL: ${n.monitor_url}\n` : ''}${n.cause ? `Cause: ${n.cause}\n` : ''}\nDashboard: ${link}\n`,
      html: shellHtml(`
        <h1 style="margin:0 0 8px;font:600 20px/1.3 system-ui;color:#a8392c">Monitor down</h1>
        <p style="margin:0 0 4px;font:600 16px/1.3 system-ui">${escape(n.monitor_name)}</p>
        ${url}${cause}${linkBtn}
      `),
    };
  }

  // recover
  return {
    subject: `[UP] ${n.monitor_name}`,
    text: `Monitor "${n.monitor_name}" has recovered.\n\n${n.monitor_url ? `URL: ${n.monitor_url}\n` : ''}\nDashboard: ${link}\n`,
    html: shellHtml(`
      <h1 style="margin:0 0 8px;font:600 20px/1.3 system-ui;color:#6b8f5e">Monitor recovered</h1>
      <p style="margin:0 0 4px;font:600 16px/1.3 system-ui">${escape(n.monitor_name)}</p>
      ${n.monitor_url ? `<p style="margin:0 0 8px;color:#475569;font:14px/1.5 system-ui">${escape(n.monitor_url)}</p>` : ''}
      <p style="margin:16px 0;font:14px/1.5 system-ui;color:#334155">Back to UP. No further action required.</p>
      ${linkBtn}
    `),
  };
}

export const emailChannel: ChannelAdapter = {
  type: 'email',
  async deliver(env: Cloudflare.Env, channel: ChannelRow | null, recipient: string, n: Notification): Promise<DeliveryAttempt> {
    const start = Date.now();
    if (!env.SEND_EMAIL || !env.EMAIL_FROM) {
      return {
        channel_id: channel?.id ?? null,
        channel_type: 'email',
        recipient,
        status: 'skipped',
        error: !env.SEND_EMAIL ? 'SEND_EMAIL binding missing' : 'EMAIL_FROM not set',
      };
    }
    const { subject, text, html } = renderEmail(n);
    try {
      await env.SEND_EMAIL.send({ to: recipient, from: env.EMAIL_FROM, subject, text, html });
      return { channel_id: channel?.id ?? null, channel_type: 'email', recipient, status: 'sent', latency_ms: Date.now() - start };
    } catch (err) {
      return { channel_id: channel?.id ?? null, channel_type: 'email', recipient, status: 'failed', latency_ms: Date.now() - start, error: (err as Error).message?.slice(0, 500) };
    }
  },
};
