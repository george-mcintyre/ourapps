-- Copyright Level N Ltd 2026
ALTER TABLE testflight_builds ADD COLUMN platform TEXT NOT NULL DEFAULT 'ios' CHECK (platform IN ('ios', 'macos', 'tvos'));
CREATE INDEX testflight_builds_platform ON testflight_builds(app_id, platform, state);
CREATE TABLE app_testflight_platforms (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('macos', 'tvos')),
  state_json TEXT NOT NULL,
  checked_at TEXT,
  PRIMARY KEY (app_id, platform)
);
CREATE TABLE installer_certificates (
  developer_id TEXT PRIMARY KEY REFERENCES developers(id) ON DELETE CASCADE,
  certificate_id TEXT NOT NULL,
  name TEXT NOT NULL,
  serial_number TEXT NOT NULL,
  certificate_base64 TEXT NOT NULL,
  expiration_date TEXT,
  created_at TEXT NOT NULL
);
