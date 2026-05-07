-- Per-monitor public visibility flag. When 1, the monitor is shown on the
-- public status page at "/" and a public detail view at "/m/<id>". When 0
-- (default), the monitor is admin-only — visible only under /admin behind
-- Cloudflare Access. Existing monitors stay private on this rollout.
ALTER TABLE monitor ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_monitor_public ON monitor(is_public) WHERE is_public = 1;
