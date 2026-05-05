# Uptime Scarecrow

Self-hosted uptime monitoring built entirely on Cloudflare, by Cloudsteading. Watches HTTP endpoints and cron heartbeats; sends alerts via email / Slack / Discord / webhook / PagerDuty / Telegram. Repo: `cloudsteading/uptime-scarecrow`. (Local dir is still `cs-uptime-monitor` for historical reasons; package + workers + DB are all `uptime-scarecrow*`.)

## Architecture

Two Workers, deployed independently:

- **`uptime-scarecrow-app`** — Astro (server output) on Workers. Serves the marketing site, dashboard, public status pages. Auth via Cloudflare Access.
- **`uptime-scarecrow-scheduler`** — cron Worker (`* * * * *`), queue consumer, hosts the Durable Objects. Owns all check execution and notification fan-out.

Bindings (see `wrangler.jsonc` / `wrangler.scheduler.jsonc`):

| Binding | Purpose |
|---|---|
| `DB` (D1) | monitors, incidents, recent_check ring buffer, workspaces, users, audit log |
| `CACHE` (KV) | JWKS, rate limits, status-page cache |
| `ARCHIVE` (R2) | long-term check history beyond `recent_check` |
| `CHECKS_AE` (Analytics Engine) | timeseries for charts |
| `NOTIFY_QUEUE` (Queues) | decouples check → notification, has DLQ |
| `MONITOR_SCHEDULER`, `HEARTBEAT_TRACKER` (DOs) | per-monitor alarms; heartbeat grace tracking |
| `AI` (Workers AI) | incident `ai_summary` generation |
| `SEND_EMAIL` | outbound alert emails |

## Conventions

- **Path alias**: `~/*` → `src/*` (see `tsconfig.json`).
- **Styling**: Tailwind v4 via `@tailwindcss/vite`. Theme tokens live in `src/styles/global.css` under `@theme`. Use semantic utilities (`bg-ink-950`, `text-ink-100`, `bg-accent-600`, `text-up`, `text-down`, `text-degraded`) — don't hardcode hex.
- **Fonts**: Inter (sans), JetBrains Mono (mono). Imported in `global.css`.
- **Env**: typed in `src/env.d.ts` under `Cloudflare.Env`. Secrets via `wrangler secret put`.
- **Migrations**: `db/migrations/*.sql`, applied with `npm run db:migrate:remote`.

## Theme — "Cache" palette

Visual identity is inspired by the Counter-Strike 2 *Cache* map: post-Soviet industrial — painted concrete, rusted steel, faded hazard paint. Default mode is dark (NOC-dashboard).

| Token | Hex | Role |
|---|---|---|
| `--color-ink-950` | `#1c1f1e` | charcoal — primary dark canvas |
| `--color-ink-900` | `#2a2c2a` | rebar — dividers |
| `--color-ink-800` | `#3a3d3b` | concrete — borders, raised surface |
| `--color-ink-500` | `#8a8a82` | ash — muted text |
| `--color-ink-100` | `#ede8dd` | bone — body text on dark / canvas on light |
| `--color-accent-500` | `#d97a2b` | rust — brand |
| `--color-up` | `#6b8f5e` | moss — UP status |
| `--color-degraded` | `#c9a24a` | mustard — DEGRADED |
| `--color-down` | `#a8392c` | oxide — DOWN |
| `--color-paused` | `#8a8a82` | ash — PAUSED |
| `--color-link` | `#4f7a8c` | steel — links / chart accents |

Status colors are single-tone (no ramp) — they're meant to read identically on both `ink-950` and `ink-100`. For tinted surfaces use `*-soft` variants (e.g. `bg-up-soft`).

## Common commands

```bash
npm run dev              # astro dev (local, with platformProxy)
npm run preview          # wrangler dev (closer-to-prod)
npm run db:migrate:local
npm run deploy           # scheduler then app
```

## Project status

Early scaffolding. Single Astro + scheduler Worker pair, D1 schema in `db/migrations/0001_init.sql`, theme locked in. Next: monitor CRUD UI, scheduler DO execution loop, first notification channel (email).
