CREATE TABLE build_number_reservations (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('macos', 'tvos')),
  version TEXT NOT NULL,
  counter INTEGER NOT NULL CHECK (typeof(counter) = 'integer' AND counter >= 1 AND counter <= 9007199254740991),
  PRIMARY KEY (app_id, platform, version)
);
