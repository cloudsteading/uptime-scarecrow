-- v0.1 alerting model: each user has an `alert_email` toggle. Defaults ON for
-- the bootstrap admin (id=1) and OFF for everyone else, so a teammate who
-- signs in once doesn't get auto-paged. Admins flip toggles in /settings.
ALTER TABLE user ADD COLUMN alert_email INTEGER NOT NULL DEFAULT 0;

UPDATE user SET alert_email = 1 WHERE is_admin = 1;
