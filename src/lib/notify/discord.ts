import type { ChannelAdapter, ChannelRow, DeliveryAttempt, Notification } from './types';

const COLOR_DOWN = 0xa8392c;
const COLOR_UP = 0x6b8f5e;
const COLOR_INFO = 0x4f7a8c;

function buildPayload(n: Notification) {
  const link = n.app_base_url + (n.monitor_id ? `/monitor/${n.monitor_id}` : '');
  if (n.kind === 'test') {
    return {
      username: 'uptime-scarecrow',
      embeds: [{
        title: 'uptime-scarecrow test',
        description: n.test_message ?? 'If you got this, the Discord channel is wired up correctly.',
        url: link, color: COLOR_INFO,
      }],
    };
  }
  const isOpen = n.kind === 'incident.open';
  const fields: { name: string; value: string; inline?: boolean }[] = [];
  if (n.monitor_url) fields.push({ name: 'URL', value: n.monitor_url });
  if (isOpen && n.cause) fields.push({ name: 'Cause', value: n.cause.slice(0, 1000) });
  return {
    username: 'scarecrow',
    embeds: [{
      title: isOpen ? `🔴 ${n.monitor_name} is DOWN` : `🟢 ${n.monitor_name} recovered`,
      url: link,
      color: isOpen ? COLOR_DOWN : COLOR_UP,
      fields,
      timestamp: new Date().toISOString(),
    }],
  };
}

export const discordChannel: ChannelAdapter = {
  type: 'discord',
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
        return { channel_id: channel?.id ?? null, channel_type: 'discord', recipient, status: 'failed', latency_ms, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      return { channel_id: channel?.id ?? null, channel_type: 'discord', recipient, status: 'sent', latency_ms };
    } catch (err) {
      return { channel_id: channel?.id ?? null, channel_type: 'discord', recipient, status: 'failed', latency_ms: Date.now() - start, error: (err as Error).message?.slice(0, 500) };
    }
  },
};
