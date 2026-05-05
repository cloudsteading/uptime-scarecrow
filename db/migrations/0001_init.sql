-- v0.1 schema. Single-tenant: one deployment per Cloudflare account, multiple
-- humans sign in via Cloudflare Access. No workspaces.

CREATE TABLE IF NOT EXISTS user (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at  INTEGER
);

CREATE TABLE IF NOT EXISTS monitor (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  type               TEXT NOT NULL CHECK (type IN ('http','heartbeat')),
  name               TEXT NOT NULL,
  config             TEXT NOT NULL,
  interval_seconds   INTEGER NOT NULL,
  grace_seconds      INTEGER NOT NULL DEFAULT 0,
  paused             INTEGER NOT NULL DEFAULT 0,
  failure_threshold  INTEGER NOT NULL DEFAULT 2,
  recovery_threshold INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by         INTEGER REFERENCES user(id)
);
CREATE INDEX IF NOT EXISTS idx_monitor_paused ON monitor(paused);

CREATE TABLE IF NOT EXISTS monitor_state (
  monitor_id              INTEGER PRIMARY KEY REFERENCES monitor(id) ON DELETE CASCADE,
  status                  TEXT NOT NULL DEFAULT 'unknown'
                            CHECK (status IN ('up','down','paused','unknown')),
  consecutive_failures    INTEGER NOT NULL DEFAULT 0,
  consecutive_successes   INTEGER NOT NULL DEFAULT 0,
  last_check_at           INTEGER,
  last_status_change_at   INTEGER,
  current_incident_id     INTEGER
);

CREATE TABLE IF NOT EXISTS incident (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id      INTEGER NOT NULL REFERENCES monitor(id) ON DELETE CASCADE,
  opened_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at     INTEGER,
  cause           TEXT,
  sample_response TEXT,
  ai_summary      TEXT
);
CREATE INDEX IF NOT EXISTS idx_incident_monitor ON incident(monitor_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_incident_open ON incident(resolved_at) WHERE resolved_at IS NULL;

-- Rolling 8-day buffer of every check, per docs/specs/timeseries.md.
-- The buffer is 8 days (not 7) so every ISO week is fully resolvable from one table.
CREATE TABLE IF NOT EXISTS recent_check (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id    INTEGER NOT NULL REFERENCES monitor(id) ON DELETE CASCADE,
  started_at    INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok','fail','timeout','error')),
  latency_ms    INTEGER,
  http_code     INTEGER,
  error_kind    TEXT,
  error_msg     TEXT
);
CREATE INDEX IF NOT EXISTS idx_recent_check_monitor ON recent_check(monitor_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_recent_check_pruning ON recent_check(started_at);

-- Permanent daily rollup: one row per monitor per UTC day. Populated by the
-- scheduler's `rollupYesterday` cron at 00:05 UTC, idempotent.
CREATE TABLE IF NOT EXISTS check_daily (
  monitor_id     INTEGER NOT NULL REFERENCES monitor(id) ON DELETE CASCADE,
  day            INTEGER NOT NULL,                -- unixepoch() / 86400
  checks         INTEGER NOT NULL DEFAULT 0,
  ups            INTEGER NOT NULL DEFAULT 0,
  downs          INTEGER NOT NULL DEFAULT 0,
  errors         INTEGER NOT NULL DEFAULT 0,
  uptime_pct     REAL    NOT NULL DEFAULT 0,
  down_seconds   INTEGER NOT NULL DEFAULT 0,
  incident_count INTEGER NOT NULL DEFAULT 0,
  p50_ms         INTEGER,
  p95_ms         INTEGER,
  p99_ms         INTEGER,
  max_ms         INTEGER,
  first_at       INTEGER,
  last_at        INTEGER,
  PRIMARY KEY (monitor_id, day)
);
CREATE INDEX IF NOT EXISTS idx_check_daily_day ON check_daily(day);

CREATE TABLE IF NOT EXISTS notification_channel (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL CHECK (type IN ('email','slack','discord','webhook','pagerduty','telegram')),
  name          TEXT NOT NULL,
  config        TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS monitor_channel (
  monitor_id  INTEGER NOT NULL REFERENCES monitor(id) ON DELETE CASCADE,
  channel_id  INTEGER NOT NULL REFERENCES notification_channel(id) ON DELETE CASCADE,
  PRIMARY KEY (monitor_id, channel_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id   INTEGER REFERENCES user(id),
  actor_email     TEXT,
  action          TEXT NOT NULL,
  target          TEXT,
  payload         TEXT,
  ip              TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_audit_recent ON audit_log(created_at DESC);
