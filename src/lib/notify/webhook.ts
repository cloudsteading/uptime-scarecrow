import type { ChannelAdapter, ChannelRow, DeliveryAttempt, Notification } from './types';

function buildPayload(n: Notification) {
  return {
    kind: n.kind,
    monitor: { id: n.monitor_id, name: n.monitor_name, url: n.monitor_url ?? null },
    incident_id: n.incident_id ?? null,
    cause: n.cause ?? null,
    test_message: n.test_message ?? null,
    timestamp: Math.floor(Date.now() / 1000),
    dashboard_url: n.app_base_url + (n.monitor_id ? `/monitor/${n.monitor_id}` : ''),
  };
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generic JSON webhook. Channel `config` can include:
 *   { url: string, secret?: string }
 * If `secret` is set, the request includes
 *   X-Scarecrow-Signature: t=<unix>,v1=<hex_hmac_sha256( "<unix>.<body>" )>
 * (Stripe-style — receiver MUST verify timestamp freshness.)
 */
export const webhookChannel: ChannelAdapter = {
  type: 'webhook',
  async deliver(env: Cloudflare.Env, channel: ChannelRow | null, recipient: string, n: Notification): Promise<DeliveryAttempt> {
    const start = Date.now();
    let secret: string | undefined;
    if (channel) {
      try { secret = (JSON.parse(channel.config) as { secret?: string }).secret; } catch { /* keep undefined */ }
    }
    const body = JSON.stringify(buildPayload(n));
    const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'scarecrow/0.1' };
    if (secret) {
      const ts = Math.floor(Date.now() / 1000);
      const sig = await hmacHex(secret, `${ts}.${body}`);
      headers['x-scarecrow-signature'] = `t=${ts},v1=${sig}`;
    }
    try {
      const res = await fetch(recipient, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
      const latency_ms = Date.now() - start;
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        return { channel_id: channel?.id ?? null, channel_type: 'webhook', recipient, status: 'failed', latency_ms, error: `HTTP ${res.status}: ${errBody.slice(0, 200)}` };
      }
      return { channel_id: channel?.id ?? null, channel_type: 'webhook', recipient, status: 'sent', latency_ms };
    } catch (err) {
      return { channel_id: channel?.id ?? null, channel_type: 'webhook', recipient, status: 'failed', latency_ms: Date.now() - start, error: (err as Error).message?.slice(0, 500) };
    }
  },
};
