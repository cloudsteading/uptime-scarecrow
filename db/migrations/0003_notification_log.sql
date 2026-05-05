-- Notification delivery log. One row per send attempt across all channels.
-- Backs the "when was this incident notified about?" timeline on the incident
-- detail page and the per-channel test/health view in /settings.
CREATE TABLE IF NOT EXISTS notification_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id    INTEGER REFERENCES monitor(id) ON DELETE SET NULL,
  incident_id   INTEGER REFERENCES incident(id) ON DELETE SET NULL,
  channel_id    INTEGER REFERENCES notification_channel(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL,              -- incident.open, incident.recover, ssl.expiry_warning, test
  channel_type  TEXT NOT NULL,              -- email, slack, discord, webhook, pagerduty, telegram
  recipient     TEXT,                       -- email or webhook URL or chat ID
  status        TEXT NOT NULL,              -- sent, failed, skipped
  latency_ms    INTEGER,
  error         TEXT,
  sent_at       INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_notify_log_incident ON notification_log(incident_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_notify_log_monitor  ON notification_log(monitor_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_notify_log_channel  ON notification_log(channel_id, sent_at DESC);
