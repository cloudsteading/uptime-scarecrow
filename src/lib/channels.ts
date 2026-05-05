// CRUD for notification_channel rows. Single-tenant, called from /settings.

import { db } from '~/lib/db';
import type { ChannelRow, ChannelType } from '~/lib/notify/types';

export async function listChannels(): Promise<ChannelRow[]> {
  const { results } = await db()
    .prepare(
      `SELECT id, type, name, config, enabled, created_at
         FROM notification_channel ORDER BY created_at`,
    )
    .all<ChannelRow>();
  return results;
}

export async function getChannel(id: number): Promise<ChannelRow | null> {
  return (await db()
    .prepare(
      `SELECT id, type, name, config, enabled, created_at
         FROM notification_channel WHERE id = ?`,
    )
    .bind(id)
    .first<ChannelRow>()) ?? null;
}

export async function createChannel(args: {
  type: ChannelType;
  name: string;
  config: Record<string, unknown>;
}): Promise<number> {
  const res = await db()
    .prepare(`INSERT INTO notification_channel (type, name, config) VALUES (?, ?, ?)`)
    .bind(args.type, args.name, JSON.stringify(args.config))
    .run();
  const id = (res.meta as { last_row_id?: number })?.last_row_id;
  if (!id) throw new Error('channel insert failed');
  return id;
}

export async function deleteChannel(id: number): Promise<boolean> {
  const res = await db().prepare(`DELETE FROM notification_channel WHERE id = ?`).bind(id).run();
  return ((res.meta as { changes?: number })?.changes ?? 0) > 0;
}

export async function setChannelEnabled(id: number, enabled: boolean): Promise<void> {
  await db()
    .prepare(`UPDATE notification_channel SET enabled = ? WHERE id = ?`)
    .bind(enabled ? 1 : 0, id)
    .run();
}

export type RecentSendStat = {
  channel_id: number | null;
  channel_type: string;
  recipient: string | null;
  status: string;
  kind: string;
  error: string | null;
  latency_ms: number | null;
  sent_at: number;
};

export async function listRecentSendsForChannel(channelId: number, limit = 10): Promise<RecentSendStat[]> {
  const { results } = await db()
    .prepare(
      `SELECT channel_id, channel_type, recipient, status, kind, error, latency_ms, sent_at
         FROM notification_log WHERE channel_id = ? ORDER BY sent_at DESC LIMIT ?`,
    )
    .bind(channelId, limit)
    .all<RecentSendStat>();
  return results;
}
