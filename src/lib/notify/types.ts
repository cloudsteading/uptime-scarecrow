// Channel-based notification dispatch — modeled loosely on Laravel's
// Notification system. A `Notification` describes WHAT happened; a `Channel`
// adapter knows HOW to deliver one. The dispatcher in `./index.ts` ties them
// together and writes to `notification_log` so every send attempt is auditable.

export type NotificationKind =
  | 'incident.open'
  | 'incident.recover'
  | 'ssl.expiry_warning'
  | 'test';

export type ChannelType = 'email' | 'slack' | 'discord' | 'webhook' | 'pagerduty' | 'telegram';

export type Notification = {
  kind: NotificationKind;
  monitor_id: number | null;
  incident_id?: number | null;
  monitor_name: string;
  monitor_url?: string;
  cause?: string;
  app_base_url: string;
  /** Test notifications carry a free-form message instead of incident details. */
  test_message?: string;
};

export type ChannelRow = {
  id: number;
  type: ChannelType;
  name: string;
  config: string;     // JSON
  enabled: number;
  created_at: number;
};

export type DeliveryAttempt = {
  channel_id: number | null;
  channel_type: ChannelType;
  recipient: string;
  status: 'sent' | 'failed' | 'skipped';
  latency_ms?: number;
  error?: string;
};

export interface ChannelAdapter {
  type: ChannelType;
  /** Deliver to a single channel-row's destination, or to a fallback recipient
   *  (e.g. a user's email when no `email` channel rows are configured). */
  deliver(env: Cloudflare.Env, channel: ChannelRow | null, recipient: string, n: Notification): Promise<DeliveryAttempt>;
}
