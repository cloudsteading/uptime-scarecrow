# Local development

## Auth bypass for local dev

By default the middleware (`src/middleware.ts`) requires Cloudflare Access on every authed route. To browse the dashboard locally without setting up Access, create a `.dev.vars` file at the repo root:

```
DEV_NO_AUTH=1
```

This var must NEVER be set in deployed environments — it grants admin to every visitor. Production deploys set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` instead (via `wrangler secret put`), and any deploy missing those secrets without `DEV_NO_AUTH` returns 503.

## Two Workers, one command

Uptime Scarecrow ships as two Workers in one repo:

- **`uptime-scarecrow-app`** (`wrangler.jsonc`) — Astro UI + API routes + heartbeat ingest.
- **`uptime-scarecrow-scheduler`** (`wrangler.scheduler.jsonc`) — Durable Object classes (`MonitorScheduler`, `HeartbeatTracker`), the per-minute cron, the rollup/prune crons, the notifications queue consumer.

The app Worker has DO bindings declared with `script_name: "uptime-scarecrow-scheduler"` — i.e. it talks to DO classes that live in the *other* Worker. Locally that means **both Workers must be running** for end-to-end check execution. They auto-discover each other via wrangler's local dev registry.

## One terminal

```bash
npm run dev
```

Runs both processes concurrently with prefixed output (`[APP]` cyan, `[SCHED]` magenta). Ctrl+C cleans up both. Default ports:

- **App (dashboard + UI):** http://localhost:4322 (Astro auto-falls-through if taken)
- **Scheduler:** http://localhost:8788

If you only need one side, `npm run dev:app` or `npm run dev:scheduler` start them individually.

## How crons behave locally

Two facts that surprise people:

1. **Cron triggers do not fire on the wall clock in `wrangler dev`.** They're wired up but never auto-invoked. You trigger them explicitly:

   ```bash
   # Hits the scheduler's /__scheduled endpoint with a given cron string
   npm run tick:arm        # * * * * *   (re-arms DO alarms)
   npm run tick:rollup     # 5 0 * * *   (yesterday → check_daily)
   npm run tick:prune      # 15 0 * * *  (drop recent_check older than 8d)
   ```

   Behind the scenes those are `curl 'http://localhost:8788/__scheduled?cron=*+*+*+*+*'`. The `--test-scheduled` flag on `wrangler dev` exposes that endpoint.

2. **Durable Object alarms DO fire on schedule** in `wrangler dev`. So the per-monitor check loop works without any cron tickling — once a `MonitorScheduler` DO calls `setAlarm(now + interval_seconds * 1000)`, workerd fires it at that time, the alarm runs the check, and the cycle repeats.

This is why the per-minute cron is a *safety net*, not the workhorse — its only job is to call `/ensure` on each active monitor's DO so any monitor that doesn't yet have an alarm gets one. Once alarms are armed, the system is self-driving.

## End-to-end smoke test

Both terminals running. Then:

```bash
# 1. Confirm migrations are in place
npm run db:migrate:local

# 2. In the UI (localhost:4321), click "+ HTTP monitor" and point it at
#    a known-good URL like https://cloudsteading.com.
# 3. Watch Terminal 1 — you should see the DO log a check within ~1 second
#    of creation. The dashboard's recent_check buffer fills as alarms fire.

# 4. Force a rollup of "yesterday's" data into check_daily:
npm run tick:rollup

# 5. Force the 8-day prune (no-op the first time around):
npm run tick:prune
```

If nothing happens after creating a monitor, the most likely cause is that Terminal 1 isn't running — the API route's `MONITOR_SCHEDULER.get(...).fetch('/ensure')` call is wrapped in `.catch(() => {})` so it fails silently in pure-`astro dev` mode.

## Resetting local state

```bash
rm -rf .wrangler/state    # nukes local D1, KV, DOs, queues
npm run db:migrate:local  # re-apply schema
```

## Why not run the cron-tick automatically?

We could add a `setInterval` shim in dev. We don't, because: (a) it'd diverge from prod behavior and hide bugs that only show up at the cron boundary, and (b) DO alarms already cover the actual check loop. The manual `npm run tick:*` commands are explicit, debuggable, and match what `wrangler tail` would show in production.
