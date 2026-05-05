# scarecrow-uptime

Free uptime monitoring, hosted entirely on Cloudflare. Stands watch over your URLs and squawks when something's wrong.

A Cloudflare Worker checks a list of URLs on a cron schedule and records the results. No servers to run, no per-check fees — it fits inside Cloudflare's free tier.

## How it works

- **URLs** — the set of endpoints to monitor (method, expected status, timeout).
- **Cron** — a Cloudflare [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/) fires the Worker on a schedule (e.g. every minute).
- **Worker** — fetches each URL, measures latency, and writes the result.
- **Storage** — check results persist in Cloudflare (KV / D1 / R2, TBD).

## Stack

- Cloudflare Workers
- Cron Triggers
- Cloudflare storage primitive (KV or D1)

## Status

Early scaffolding. Roadmap:

- [ ] Worker that fetches a hardcoded URL list
- [ ] Cron trigger wired up
- [ ] Persist check results
- [ ] Config-driven URL list
- [ ] Status page / API
- [ ] Alerting (email / webhook)
