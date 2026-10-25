CREATE TABLE build_run_reservations (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('macos', 'tvos')),
  version TEXT NOT NULL,
  build_number TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  run_id TEXT NOT NULL,
  run_attempt TEXT NOT NULL,
  run_created_at TEXT NOT NULL,
  run_started_at TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  PRIMARY KEY (app_id, platform, version, build_number),
  UNIQUE (app_id, platform, github_repo, run_id, run_attempt)
);
