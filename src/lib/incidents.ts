// Incident state machine. Called from MonitorScheduler / HeartbeatTracker DOs
// after each check. Single-tenant — no workspace scoping.

import { db } from '~/lib/db';
import type { CheckOutcome } from '~/lib/checks';
import { env } from 'cloudflare:workers';

export type StateTransition = 'open' | 'recover' | 'none';

export async function applyCheckOutcome(args: {
  monitor_id: number;
  outcome: CheckOutcome;
  failure_threshold: number;
  recovery_threshold: number;
}): Promise<{ transition: StateTransition; incident_id: number | null }> {
  const d = db();
  const now = Math.floor(Date.now() / 1000);
  const isFail = args.outcome.status !== 'ok';

  await d
    .prepare(
      `INSERT INTO monitor_state (monitor_id, status, consecutive_failures, consecutive_successes, last_check_at)
         VALUES (?, 'unknown', 0, 0, ?)
         ON CONFLICT(monitor_id) DO NOTHING`,
    )
    .bind(args.monitor_id, now)
    .run();

  const state = await d
    .prepare(
      `SELECT monitor_id, status, consecutive_failures, consecutive_successes,
              last_check_at, last_status_change_at, current_incident_id
         FROM monitor_state WHERE monitor_id = ?`,
    )
    .bind(args.monitor_id)
    .first<{
      monitor_id: number;
      status: 'up' | 'down' | 'paused' | 'unknown';
      consecutive_failures: number;
      consecutive_successes: number;
      last_check_at: number | null;
      last_status_change_at: number | null;
      current_incident_id: number | null;
    }>();
  if (!state) throw new Error('monitor_state missing');

  const newFailures = isFail ? state.consecutive_failures + 1 : 0;
  const newSuccesses = isFail ? 0 : state.consecutive_successes + 1;

  let nextStatus = state.status;
  let transition: StateTransition = 'none';
  let incidentId = state.current_incident_id;

  if ((state.status === 'up' || state.status === 'unknown') && newFailures >= args.failure_threshold) {
    nextStatus = 'down';
    transition = 'open';
    const res = await d
      .prepare(
        `INSERT INTO incident (monitor_id, opened_at, cause, sample_response)
           VALUES (?, ?, ?, ?)`,
      )
      .bind(
        args.monitor_id,
        now,
        `${args.outcome.error_kind ?? 'fail'}: ${args.outcome.error_msg ?? 'check failed'}`.slice(0, 500),
        args.outcome.body_sample ?? null,
      )
      .run();
    incidentId = (res.meta as { last_row_id?: number })?.last_row_id ?? null;
  } else if (state.status === 'down' && newSuccesses >= args.recovery_threshold) {
    nextStatus = 'up';
    transition = 'recover';
    if (state.current_incident_id) {
      await d
        .prepare(`UPDATE incident SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL`)
        .bind(now, state.current_incident_id)
        .run();
    }
    incidentId = null;
  } else if (state.status === 'unknown' && newSuccesses >= args.recovery_threshold) {
    nextStatus = 'up';
  }

  const statusChanged = nextStatus !== state.status;
  await d
    .prepare(
      `UPDATE monitor_state
         SET status = ?, consecutive_failures = ?, consecutive_successes = ?,
             last_check_at = ?, last_status_change_at = ?, current_incident_id = ?
         WHERE monitor_id = ?`,
    )
    .bind(
      nextStatus, newFailures, newSuccesses, now,
      statusChanged ? now : state.last_status_change_at,
      incidentId, args.monitor_id,
    )
    .run();

  await d
    .prepare(
      `INSERT INTO recent_check (monitor_id, started_at, status, latency_ms, http_code, error_kind, error_msg)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.monitor_id, now, args.outcome.status,
      args.outcome.latency_ms, args.outcome.http_code ?? null,
      args.outcome.error_kind ?? null, args.outcome.error_msg?.slice(0, 1000) ?? null,
    )
    .run();

  if (transition !== 'none' && env.NOTIFY_QUEUE) {
    await env.NOTIFY_QUEUE.send({
      kind: transition === 'open' ? 'incident.open' : 'incident.recover',
      monitor_id: args.monitor_id,
      incident_id: incidentId ?? undefined,
      payload: { status: nextStatus, outcome: args.outcome },
    });
  }

  return { transition, incident_id: incidentId };
}
