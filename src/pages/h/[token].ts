// Heartbeat ingest. Public endpoint — no Access. Looks up the monitor by
// SHA-256 hash of the URL token, then fans the ping to its DO.

import type { APIRoute } from 'astro';
import { findHeartbeatMonitorByToken } from '~/lib/monitors';
import { env } from 'cloudflare:workers';

const handler: APIRoute = async (ctx) => {
  const token = ctx.params.token;
  if (typeof token !== 'string' || token.length < 16 || token.length > 200) {
    return new Response('not found', { status: 404 });
  }

  // Detect /h/{token}/start, /h/{token}/fail trailing path. The Astro [token]
  // route only matches a single segment, so /h/{token}/fail will 404 unless
  // we add a separate route file. v0.1: simple ingest only — `/start` and
  // `/fail` are v0.2.

  const monitor = await findHeartbeatMonitorByToken(token).catch(() => null);
  if (!monitor) return new Response('not found', { status: 404 });
  if (monitor.paused) return new Response('paused', { status: 200 });

  const ns = env.HEARTBEAT_TRACKER;
  if (!ns) return new Response('scheduler not bound', { status: 503 });
  const stub = ns.get(ns.idFromName(`m:${monitor.id}`));

  try {
    await stub.fetch('https://do/ping', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monitor_id: monitor.id, outcome: 'ok' }),
    });
  } catch (err) {
    console.warn(`heartbeat DO ping ${monitor.id} failed:`, (err as Error).message);
    return new Response('ok', { status: 200 });
  }

  return new Response('ok', { status: 200 });
};

export const GET = handler;
export const POST = handler;
export const HEAD = handler;
