CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song TEXT NOT NULL,
  artist TEXT,
  occasion TEXT,
  years TEXT,
  from_name TEXT,
  to_name TEXT,
  comments TEXT,
  created_at INTEGER NOT NULL,
  played INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_requests_pending ON requests (played, archived, created_at);

-- Small key/value store (cached gig windows parsed from the live site)
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
