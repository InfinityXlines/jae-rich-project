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
  played INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_requests_pending ON requests (played, created_at);
