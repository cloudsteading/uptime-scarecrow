# Spec: Check timeseries storage

## Goal

Show check history per monitor, fast, paginated week-by-week, forever. Cloudflare-only.

## Model

Two D1 tables, two cron jobs. No Analytics Engine, no KV cache.

| Table | Window | Granularity | Source of truth for |
|---|---|---|---|
| `recent_check` (existing) | rolling 8 days | per check | current week + last week |
| `check_daily` (new) | forever | per monitor per day | older weeks |

8-day buffer guarantees any ISO-week page is fully in one table.

## `check_daily` schema

```
PRIMARY KEY (monitor_id, day)            -- day = unixepoch() / 86400
checks, ups, downs, errors               -- counts
uptime_pct REAL                          -- 100.0 * ups / checks
down_seconds, incident_count
p50_ms, p95_ms, p99_ms, max_ms
first_at, last_at                        -- unix ts
```

Percentiles computed via SQLite `ROW_NUMBER()` window over `recent_check`, or in-Worker from a `latency_ms` array — whichever stays simpler.

## Cron jobs (in scheduler Worker)

| Cron | Job | Behavior |
|---|---|---|
| `* * * * *` | `runChecks` | existing |
| `5 0 * * *` | `rollupYesterday` | `INSERT OR REPLACE INTO check_daily` per monitor for prior UTC day |
| `15 0 * * *` | `pruneRecentChecks` | `DELETE FROM recent_check WHERE started_at < now - 8d` |

Both new jobs idempotent. Prune runs *after* rollup.

## Read path

`GET /app/monitor/:id?week=YYYY-WW` (ISO week, defaults to current).

```
ageDays = (now - weekStart) / 86400
if ageDays < 8:
  read recent_check  → dense timeline (per-check chart, incidents, latency line)
else:
  read check_daily   → 7 daily bars (uptime %, p95, down minutes)
```

UI: prev/next-week arrows, week picker. Hint banner on dense view: *"Detailed history kept for 8 days; older weeks show daily summaries."*

## Non-goals

- No high-cardinality drilldown past 8 days (no per-error-message search in history).
- No sub-daily granularity past 8 days.
- No cross-monitor aggregation in the timeseries store.

## Open questions

- Top-N error kinds per day in `check_daily` as JSON? (~50 bytes/row, makes "what failed in week N" possible.)
- Compute percentiles in SQL or in-Worker? Default to in-Worker for v1; revisit if rollup latency matters.
