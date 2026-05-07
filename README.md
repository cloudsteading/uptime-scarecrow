# Uptime Scarecrow

Self-hosted uptime monitoring built entirely on Cloudflare — by [Cloudsteading](https://cloudsteading.com).

Stands watch over your URLs and cron jobs and squawks when something's wrong. Two Workers, one D1 database, no third parties. Deploys to your own Cloudflare account in a few minutes; expect to pay $2–5/month at indie scale.

---

## What it does

- **HTTP monitors** — fetches a URL on a schedule (1m, 5m, 15m, hourly, or any cron) and asserts on status code, body content, response time, and TLS expiry.
- **Heartbeat monitors** — exposes a per-monitor URL (`/h/<token>`); your job pings it on a schedule and the monitor flips DOWN if it goes silent past a grace period.
- **Incidents** — opens an incident when a monitor flips DOWN, closes it on recovery, optionally writes an AI-generated summary via Workers AI.
- **Notifications** — fans out via email (Cloudflare Email Service), Slack, Discord, and signed JSON webhooks. PagerDuty and Telegram adapters are stubbed for v0.2.
- **Public status page** at `/` — standard statuspage layout (overall banner, per-monitor uptime sparkline, recent incidents). Each monitor has an `is_public` flag; only flagged monitors appear publicly.
- **Admin dashboard** under `/admin/*` — gated by Cloudflare Access. Operator-only views, monitor CRUD, channel CRUD, settings, audit log. No app-side login UI; Access is the login.
- **Auth model** — Access protects only `/admin/*` (and `/admin/api/v1/*`). Everything else (public status page, public monitor detail at `/m/<id>`, `/about`, `/h/<token>`) is unauthenticated by design.

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
| `/about` | public | Project info |
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

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com) with Workers, D1, KV, Queues, Durable Objects, Workers AI, and Email Routing enabled (most are on the free plan; Queues + DOs require the $5/mo Workers Paid plan).
- A custom domain on Cloudflare (or a `*.workers.dev` subdomain — but Email Routing requires a real zone).
- A [Zero Trust](https://one.dash.cloudflare.com/) account for Cloudflare Access (free tier supports 50 users).
- Node.js ≥ 22.12 (matches `engines` in `package.json`; the version in `.nvmrc`).
- `wrangler` CLI authenticated against your account: `npx wrangler login`.

---

## Quickstart — local development

```bash
# 1. Clone & install
git clone https://github.com/cloudsteading/uptime-scarecrow.git
cd uptime-scarecrow
nvm use         # honours .nvmrc
npm install

# 2. Enable the local auth bypass (gitignored, never committed)
cat > .dev.vars <<'EOF'
DEV_NO_AUTH=1
EOF

# 3. Apply migrations to the local D1 (creates ./.wrangler/state)
npm run db:migrate:local

# 4. Run both Workers concurrently
npm run dev
```

This starts:

- **App / dashboard:** http://localhost:4322 (Astro auto-falls-through if 4322 is taken — watch the `[APP]` line for the actual port)
- **Scheduler:** http://localhost:8788 (cron tickle endpoint at `/__scheduled?cron=...`)

Browse to the app and you should land on the empty Monitors dashboard. Add an HTTP monitor and within ~1 second its DO will arm an alarm and start checking. See [`docs/dev.md`](docs/dev.md) for the full local workflow, including manual cron tickling for the daily rollup/prune.

---

## Production deployment

The repo currently ships with the maintainer's account and resource IDs in the wrangler configs. **Replace them with your own** before deploying — otherwise wrangler will refuse, or worse, target the wrong resources.

### 1. Provision Cloudflare resources

```bash
# D1
npx wrangler d1 create uptime-scarecrow-db
# → copy the database_id into both wrangler.jsonc and wrangler.scheduler.jsonc

# KV
npx wrangler kv:namespace create CACHE
# → copy the id into both wrangler configs

# Queue
npx wrangler queues create uptime-scarecrow-notifications
npx wrangler queues create uptime-scarecrow-notifications-dlq
```

Update `wrangler.jsonc` and `wrangler.scheduler.jsonc`:

- `account_id` — your Cloudflare account ID (or remove and set `CLOUDFLARE_ACCOUNT_ID` in your shell)
- `d1_databases[0].database_id` — from step 1
- `kv_namespaces[0].id` — from step 1
- `unsafe.bindings[0].namespace_id` — pick any unique number per worker for the rate limiter (e.g. `1001`)

### 2. Configure Cloudflare Access

Access protects only `/admin/*` — the public status page at `/` stays open. In the [Zero Trust dashboard](https://one.dash.cloudflare.com/):

1. **Settings → Authentication** — set up at least one identity provider (Google, GitHub, one-time PIN, etc.).
2. **Access → Applications → Add an application → Self-hosted.**
3. Application domain: the hostname you'll deploy the app to **with the `/admin` path** (e.g. `uptime.example.com/admin`). This way Access only intercepts admin traffic; the public status page is untouched.
4. Add an Access Policy that allows your email(s).
5. After saving, open the application's settings and copy:
   - **AUD tag** (the long hex string) → set as `ACCESS_AUD` secret
   - **Team domain** (e.g. `your-team.cloudflareaccess.com`) → set as `ACCESS_TEAM_DOMAIN` secret

### 3. Configure Email Routing

In the Cloudflare dashboard for your zone:

1. **Email → Email Routing → Get started** and verify your domain.
2. **Email Routing → Email Workers → Create a destination address** for the from-address you want alerts to use (e.g. `alerts@yourdomain.com`). Verify it.
3. The `SEND_EMAIL` binding in `wrangler.jsonc` is `unrestricted` — add a `destination_addresses` array if you want to constrain who Scarecrow can email.

### 4. Set Worker secrets

For both Workers, set required secrets via wrangler:

```bash
# These two are required — without them, the app refuses to serve any authed route.
npx wrangler secret put ACCESS_TEAM_DOMAIN          # e.g. your-team.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD                  # the AUD tag from Access

# Email
npx wrangler secret put EMAIL_FROM                  # e.g. alerts@yourdomain.com

# Optional
npx wrangler secret put ALLOWED_EMAILS              # comma-separated allowlist; empty = anyone Access lets through
npx wrangler secret put BOOTSTRAP_ADMIN_EMAILS      # comma-separated — these emails get is_admin=1 on first login
npx wrangler secret put APP_BASE_URL                # e.g. https://uptime.example.com — used in alert email links

# Repeat for the scheduler worker
npx wrangler secret put EMAIL_FROM -c wrangler.scheduler.jsonc
# … etc, for any secret the scheduler needs (it sends emails too)
```

`DEV_NO_AUTH` must NEVER be set in production. The middleware fails closed when `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are missing unless `DEV_NO_AUTH=1`, so a forgotten Access config returns 503 rather than silently granting admin.

### 5. Apply migrations to the remote D1

```bash
npm run db:migrate:remote
```

### 6. Deploy

```bash
npm run deploy
```

This deploys the scheduler first (so its DO classes exist before the app tries to bind to them), then the app. Both go live behind your custom domain once the Workers route is set in the dashboard.

### 7. Smoke-check

- Visit your deployed URL — you should hit the Cloudflare Access sign-in flow, then land on the empty Monitors dashboard.
- Add an HTTP monitor pointed at a known-good URL.
- Wait a minute. The dashboard should show a green check.
- **Settings → Send test email** to confirm `SEND_EMAIL` is wired correctly.

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

- **Auth.** Cloudflare Access JWT (verified via JWKS, RS256) is required only for `/admin` and `/admin/*` (which covers `/admin/api/v1/*`). Email allowlist enforced after JWT verification. The public status page (`/`, `/m/<id>`), `/about`, and `/h/<token>` are public by design — anyone can hit them, but the public monitor detail returns 404 unless the monitor's `is_public` column is 1.
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

MIT — see `LICENSE` (TODO: add file).

---

## Contributing

This is an early-stage, single-tenant project — Cloudsteading uses it for our own monitoring. Issues and PRs welcome at [github.com/cloudsteading/uptime-scarecrow](https://github.com/cloudsteading/uptime-scarecrow). For substantial changes, open an issue first to discuss scope.
