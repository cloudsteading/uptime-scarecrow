# Uptime Scarecrow

Self-hosted uptime monitoring built entirely on Cloudflare — by [Cloudsteading](https://cloudsteading.com).

Stands watch over your URLs and cron jobs and squawks when something's wrong. Two Workers, one D1 database, no third parties. Deploys to your own Cloudflare account in a few minutes; expect to pay $2–5/month at indie scale.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudsteading/uptime-scarecrow)

> The Deploy button forks this repo into your GitHub, connects it to your Cloudflare account, and runs `npm run deploy`. D1, KV, and DO resources auto-provision on first run. Queues need to be created once before the first deploy — see [§ Quick install](#quick-install) for the full step list.

---

## Features

- **HTTP monitors** — schedule (1m / 5m / 15m / hourly / any cron); assert on status code, body keyword, response time, and TLS expiry. Per-token rate-limited heartbeat ingest at `/h/<token>`.
- **Heartbeat monitors** — *your* job pings Uptime Scarecrow; alerts when the ping goes silent past a configurable grace window.
- **Incidents** — auto-opened on DOWN, auto-closed on recovery, optionally summarised by Workers AI.
- **Notifications** — Cloudflare Email Service, Slack, Discord, signed JSON webhooks. PagerDuty + Telegram are stubbed for v0.2.
- **Public status page** at `/` — standard statuspage UX. Per-monitor `is_public` flag; private by default.
- **Admin** under `/admin/*` — Cloudflare Access in front, no app-side login UI.

---

## Quick install

You'll need a Cloudflare account on the **Workers Paid** plan ($5/mo — required for Durable Objects + Queues), Node ≥ 22.12, and `wrangler` authenticated (`npx wrangler login`).

```bash
# 1. Clone and install
git clone https://github.com/cloudsteading/uptime-scarecrow.git
cd uptime-scarecrow
nvm use && npm install

# 2. Create the two queues (these are the only resources wrangler can't auto-provision yet)
npx wrangler queues create uptime-scarecrow-notifications
npx wrangler queues create uptime-scarecrow-notifications-dlq

# 3. First deploy. wrangler auto-creates D1, KV, and the DO classes on demand.
npm run deploy

# 4. Apply schema to the freshly-created remote D1
npm run db:migrate:remote
```

The app is now reachable at `https://uptime-scarecrow-app.<your-subdomain>.workers.dev`. Public status page works immediately; `/admin` returns 503 until you set up Cloudflare Access in step 5.

```bash
# 5. Set required secrets — see "Production setup" below for how to obtain each value
npx wrangler secret put ACCESS_TEAM_DOMAIN     # e.g. your-team.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD             # 64-char hex from your Access app
npx wrangler secret put EMAIL_FROM             # e.g. alerts@your-domain.com
```

After that, `https://uptime-scarecrow-app.<your-subdomain>.workers.dev/admin` redirects through your IdP and into the dashboard.

For a custom domain, see [§ Custom domain](#custom-domain) below.

---

## Architecture

Two Workers in one repo:

| Worker | Config | Role |
|---|---|---|
| `uptime-scarecrow-app` | `wrangler.jsonc` | Astro server output — public status page (`/`, `/m/<id>`), Access-gated admin dashboard (`/admin/*`), JSON API (`/admin/api/v1/*`), heartbeat ingest (`/h/<token>`). |
| `uptime-scarecrow-scheduler` | `wrangler.scheduler.jsonc` | Per-minute cron, daily rollup/prune crons, queue consumer for notifications, hosts Durable Object classes (`MonitorScheduler`, `HeartbeatTracker`). |

The app talks to DOs that live *inside* the scheduler Worker (cross-Worker DO bindings via `script_name`). Both Workers share the same D1, KV, and Queue.

### Routes at a glance

| Path | Auth | Purpose |
|---|---|---|
| `/` | public | Status page — public monitors, banner, recent incidents |
| `/m/<id>` | public | Public monitor detail (404 if `is_public = 0`) |
| `/h/<token>` | public, rate-limited | Heartbeat ingest |
| `/admin` | Access | Admin dashboard (all monitors) |
| `/admin/incidents`, `/admin/settings`, `/admin/monitor/*`, `/admin/incident/*` | Access | Operator views |
| `/admin/api/v1/*` | Access | JSON / form API |

```
HTTP / heartbeat
       │
       ▼
[ uptime-scarecrow-app ]  ◄──── Cloudflare Access (JWT)
       │
       ├── DB writes ──► D1
       ├── ensure DO  ──► [ MonitorScheduler DO ]  (in scheduler worker)
       │                       │  alarm fires every interval_seconds
       │                       ▼
       │                  performCheck()
       │                       │
       │                       ├── recent_check (8d ring)  ──► D1
       │                       └── state machine ──► incident open/close
       │                                                │
       │                                                ▼
       │                                         NOTIFY_QUEUE
       │                                                │
       └────────────────────────── [ scheduler queue consumer ]
                                                        │
                                                        ▼
                                          email / slack / discord / webhook
```

### Storage model

- **D1 (`uptime-scarecrow-db`)** — monitors, incidents, channels, users, audit log, `recent_check` (8-day rolling per-check ring) and `check_daily` (forever rollups).
- **KV (`CACHE`)** — JWKS cache for Access JWT verification, status-page cache.
- **Queue (`uptime-scarecrow-notifications`)** — decouples check state changes from notification fan-out, with DLQ.
- **Rate-limit binding** — caps `/h/<token>` heartbeat ingest at 30 req/min per token.
- **Workers AI** — incident summaries.
- **Email Routing → `SEND_EMAIL` binding** — outbound alerts.

There is *no* R2, no Analytics Engine, no Postgres, no Redis. Timeseries are D1-only.

---

## Local development

```bash
git clone https://github.com/cloudsteading/uptime-scarecrow.git
cd uptime-scarecrow
nvm use && npm install

# Local auth bypass — gitignored, never committed.
cp .dev.vars.example .dev.vars      # contains DEV_NO_AUTH=1

# Local D1 schema
npm run db:migrate:local

# App + scheduler concurrently. Auto-arms DO alarms on startup.
npm run dev
```

- **App:** http://localhost:4322  (Astro auto-falls-through if 4322 is taken; watch the `[APP]` line)
- **Scheduler:** http://localhost:8788  (cron tickle: `/__scheduled?cron=...`)

See [`docs/dev.md`](docs/dev.md) for the full local workflow.

---

## Production setup

The Quick install above gets the workers deployed and resources auto-provisioned. The remaining work is connecting Cloudflare Access (so `/admin` works) and Email Routing (so alerts deliver). Both are dashboard tasks.

### Cloudflare Access (gates `/admin`)

Access only intercepts `/admin/*` — public status page stays open. In the [Zero Trust dashboard](https://one.dash.cloudflare.com/):

1. **Settings → Authentication → Login methods → Add new** — pick at least one IdP. Google or GitHub OAuth are most reliable; one-time PIN works but depends on email deliverability.
2. **Access → Applications → Add an application → Self-hosted.**
3. **Application domain** — your worker's hostname (the workers.dev URL or your custom domain) **with the `Path` set to `admin`**. This is critical: it scopes Access to admin only.
4. **Identity providers** — check the IdP from step 1.
5. **Add a policy** — `Allow` action, `Include → Emails →` your operator emails.
6. Save. On the app's Overview tab, copy:
   - **AUD tag** → `npx wrangler secret put ACCESS_AUD`
   - **Team domain** (e.g. `your-team.cloudflareaccess.com`) → `npx wrangler secret put ACCESS_TEAM_DOMAIN`

The middleware fails closed if either secret is missing — `/admin` returns 503 rather than silently granting access.

### Email Routing (powers notifications)

The `send_email` binding requires the from-domain to be on a Cloudflare zone with Email Routing enabled. To avoid colliding with your existing mail (e.g. Google Workspace on the apex), use a dedicated subdomain like `m.your-domain.com`.

1. Cloudflare dashboard → your zone (or subdomain zone) → **Email → Email Routing → Get Started.**
2. CF auto-adds MX + SPF + DKIM records. Click **Add records and enable**.
3. Add a destination address (any real inbox you control) and verify it via the email link.
4. Pick a from-address (e.g. `alerts@m.your-domain.com`) — it doesn't need to be a real inbox; the binding just needs the *zone* enabled.

```bash
npx wrangler secret put EMAIL_FROM                              # e.g. alerts@m.your-domain.com
npx wrangler secret put EMAIL_FROM -c wrangler.scheduler.jsonc  # the queue consumer also sends mail
```

Test from the dashboard: `/admin/settings → Send test email to me`.

### Optional secrets

```bash
npx wrangler secret put APP_BASE_URL              # e.g. https://uptime.your-domain.com — used in alert email links
npx wrangler secret put BOOTSTRAP_ADMIN_EMAILS    # comma-separated — these get is_admin=1 on first login
npx wrangler secret put ALLOWED_EMAILS            # comma-separated allowlist; defense-in-depth on top of Access
```

> `DEV_NO_AUTH` must NEVER be set in production. The middleware fails closed when `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` are missing unless `DEV_NO_AUTH=1`, so a forgotten Access config returns 503 rather than silently granting admin.

### Custom domain

Add a domain like `uptime.your-domain.com` either way:

**Dashboard** — Workers & Pages → `uptime-scarecrow-app` → Settings → Domains & Routes → Add → Custom Domain. Hostname must be a CF zone in the same account; DNS is auto-created. Persists across deploys without committing anything.

**Wrangler config** — uncomment + edit the `routes` block in `wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "uptime.example.com", "custom_domain": true }
]
```

…then redeploy. Note: with `routes` in config, wrangler manages the binding declaratively — removing it later detaches the domain on next deploy. Dashboard-added domains are independent.

### Smoke-check

- Visit `/` — you should see "No public monitors" on the public status page.
- Visit `/admin` — should redirect through your IdP and into an empty Monitors dashboard.
- Add an HTTP monitor pointed at a known-good URL. Wait ~5s — the bar starts filling.
- **Settings → Send test email to me** — confirms `SEND_EMAIL` wiring end-to-end.

---

## Notification channels

Configured under **Settings** in the dashboard. Each channel row stores its config as JSON in D1.

| Channel | `recipient` shape | `config` |
|---|---|---|
| `email` | email address | `{}` |
| `slack` | incoming webhook URL | `{}` |
| `discord` | webhook URL | `{}` |
| `webhook` | webhook URL | `{ "url": "...", "secret": "..." }` — if `secret` is set, the request includes `X-Scarecrow-Signature: t=<unix>,v1=<hex_hmac_sha256("<unix>.<body>")>` (Stripe-style; receiver must verify timestamp freshness) |

Webhook payload:

```json
{
  "kind": "incident.open" | "incident.recover" | "test",
  "monitor": { "id": 7, "name": "API", "url": "https://api.example.com/health" },
  "incident_id": 42,
  "cause": "HTTP 502 (Bad Gateway)",
  "timestamp": 1730000000,
  "dashboard_url": "https://uptime.example.com/monitor/7"
}
```

---

## Configuration reference

### Worker secrets

| Name | Required? | Purpose |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | yes (prod) | e.g. `your-team.cloudflareaccess.com`. Used to fetch JWKS for JWT verification. |
| `ACCESS_AUD` | yes (prod) | AUD tag for the Access application protecting this Worker. |
| `EMAIL_FROM` | yes (for email alerts) | The verified Email Routing address used as the `From:` header. |
| `ALLOWED_EMAILS` | no | Comma-separated email allowlist enforced *after* Access (defence in depth). |
| `BOOTSTRAP_ADMIN_EMAILS` | no | Emails matching this list get `is_admin=1` on first login. |
| `APP_BASE_URL` | no | Used to build dashboard links inside alert emails / webhook payloads. |
| `DEV_NO_AUTH` | dev only | Set to `1` in `.dev.vars` to bypass Access locally. NEVER set in prod. |

### Vars (in wrangler config)

| Name | Default | Purpose |
|---|---|---|
| `APP_NAME` | `uptime-scarecrow` | Used in user-agent strings and audit logs. |
| `APP_VERSION` | `0.1.0` | Same. |

### Cron schedules

The scheduler worker fires three crons (defined in `wrangler.scheduler.jsonc`):

| Cron | What it does |
|---|---|
| `* * * * *` | Per-minute safety net — re-arms DO alarms for any active monitor that doesn't have one. |
| `5 0 * * *` | Daily rollup — yesterday's `recent_check` rows → `check_daily`. |
| `15 0 * * *` | Daily prune — drops `recent_check` rows older than 8 days. |

Per-monitor checks are driven by **Durable Object alarms**, not by these crons. Once a monitor's DO calls `setAlarm(now + interval_seconds * 1000)`, workerd fires it on schedule and the DO re-arms itself. The minute-cron is a safety net for cases where alarms get cleared (deploys, etc.).

---

## Security

A summary of the security boundaries — see `src/middleware.ts`, `src/lib/access.ts`, and `src/lib/checks.ts` for the implementation.

- **Auth.** Cloudflare Access JWT (verified via JWKS, RS256) is required only for `/admin` and `/admin/*` (which covers `/admin/api/v1/*`). Email allowlist enforced after JWT verification. The public status page (`/`, `/m/<id>`) and `/h/<token>` are public by design — anyone can hit them, but the public monitor detail returns 404 unless the monitor's `is_public` column is 1.
- **SSRF.** Outbound check fetches block `localhost`, `127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (incl. cloud metadata `169.254.169.254`), `100.64.0.0/10`, fc00::/7, and DoH-resolve before fetch with redirect re-validation.
- **Heartbeat tokens.** 32 bytes from `crypto.getRandomValues`, stored as SHA-256 hash. Lookup is constant-time hash-compare. Per-token rate limit at 30 req/min.
- **Webhook signatures.** Optional HMAC-SHA256 over `<unix-ts>.<body>`, sent as `X-Scarecrow-Signature: t=<unix>,v1=<hex>`. Receivers must verify timestamp freshness to prevent replay.
- **CSRF.** Same-origin policy + Access JWT on all mutating routes. No anti-CSRF token because Access cookies are scoped to the Access application's hostname.
- **Audit log.** Every mutation (channel CRUD, monitor CRUD, email send) writes a row to `audit_log` with actor email and IP.

For the local-dev auth bypass: see the `DEV_NO_AUTH` note above. The middleware fails closed if Access env vars are missing in production, so a misconfigured deploy returns 503 rather than granting access.

---

## Project layout

```
.
├── db/migrations/        # 0001_init.sql + later migrations
├── docs/
│   ├── dev.md            # local development guide
│   └── specs/timeseries.md
├── scripts/
│   └── smoke-test.sh
├── src/
│   ├── components/       # Astro components (charts, logo, cron preview)
│   ├── do/               # Durable Object classes
│   ├── layouts/
│   ├── lib/
│   │   ├── access.ts     # Cloudflare Access JWT verification
│   │   ├── checks.ts     # HTTP check execution + SSRF guards
│   │   ├── monitors.ts   # monitor CRUD + heartbeat token lifecycle
│   │   ├── notify/       # channel adapters (email/slack/discord/webhook)
│   │   └── …
│   ├── middleware.ts     # Astro middleware: Access JWT → ctx.locals.user
│   ├── pages/
│   │   ├── api/v1/       # JSON API
│   │   ├── app/          # dashboard
│   │   ├── h/[token].ts  # heartbeat ingest (public, rate-limited)
│   │   └── …
│   ├── scheduler/        # the scheduler Worker entrypoint
│   ├── styles/global.css # Tailwind v4 + theme tokens
│   └── env.d.ts
├── wrangler.jsonc          # app worker
└── wrangler.scheduler.jsonc # scheduler worker
```

---

## License

[MIT](./LICENSE).

---

## Contributing

This is an early-stage, single-tenant project — Cloudsteading uses it for our own monitoring, and we're sharing it for anyone else to deploy on their own Cloudflare account. Issues and PRs welcome at [github.com/cloudsteading/uptime-scarecrow](https://github.com/cloudsteading/uptime-scarecrow).

A few notes for contributors:

- **Branch from `main`**, ship small focused PRs. Substantial changes should land an issue first to confirm scope.
- **Local dev:** see [`docs/dev.md`](docs/dev.md). One command (`npm run dev`) runs both workers, auto-arms DO alarms, and gives you a `/admin` you can browse via the `DEV_NO_AUTH=1` bypass.
- **Schema changes** go in `db/migrations/NNNN_<description>.sql` (sequential numbering). Run `npm run db:migrate:local` to apply.
- **Type-check before pushing:** `npx tsc --noEmit`. We don't have a full test suite yet — `scripts/smoke-test.sh` is the closest thing.
- **`docs/specs/`** is where v0.2 design notes go before they become migrations / code.

Roughly what's on the v0.2 list (file an issue if you want to tackle one): PagerDuty + Telegram channel adapters, comments on incidents, configurable header navigation, daily check_daily fallback for chart data older than 8 days, status-page subscriber emails, monitor groups.
