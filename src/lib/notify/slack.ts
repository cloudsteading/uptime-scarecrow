import type { ChannelAdapter, ChannelRow, DeliveryAttempt, Notification } from './types';

function buildPayload(n: Notification) {
  const link = n.app_base_url + (n.monitor_id ? `/monitor/${n.monitor_id}` : '');
  if (n.kind === 'test') {
    return {
      text: `:wave: uptime-scarecrow test — ${n.test_message ?? 'channel works'}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `:wave: *uptime-scarecrow test*\n${n.test_message ?? 'If you got this, the Slack channel is wired up correctly.'}\n<${link}|Open dashboard>` } },
      ],
    };
  }
  const isOpen = n.kind === 'incident.open';
  const headline = isOpen ? `🔴 *${n.monitor_name}* is DOWN` : `🟢 *${n.monitor_name}* recovered`;
  const fields: { type: string; text: string }[] = [];
  if (n.monitor_url) fields.push({ type: 'mrkdwn', text: `*URL*\n${n.monitor_url}` });
  if (isOpen && n.cause) fields.push({ type: 'mrkdwn', text: `*Cause*\n${n.cause}` });
  return {
    text: `${isOpen ? '[DOWN]' : '[UP]'} ${n.monitor_name}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: headline } },
      ...(fields.length ? [{ type: 'section', fields }] : []),
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open monitor' }, url: link }] },
    ],
  };
}

export const slackChannel: ChannelAdapter = {
  type: 'slack',
  async deliver(env: Cloudflare.Env, channel: ChannelRow | null, recipient: string, n: Notification): Promise<DeliveryAttempt> {
    const start = Date.now();
    try {
      const res = await fetch(recipient, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildPayload(n)),
        signal: AbortSignal.timeout(10_000),
      });
      const latency_ms = Date.now() - start;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { channel_id: channel?.id ?? null, channel_type: 'slack', recipient, status: 'failed', latency_ms, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      return { channel_id: channel?.id ?? null, channel_type: 'slack', recipient, status: 'sent', latency_ms };
    } catch (err) {
      return { channel_id: channel?.id ?? null, channel_type: 'slack', recipient, status: 'failed', latency_ms: Date.now() - start, error: (err as Error).message?.slice(0, 500) };
    }
  },
};
