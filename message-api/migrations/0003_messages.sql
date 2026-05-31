CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id TEXT NOT NULL,
  volume_ml REAL NOT NULL,
  cost_usd REAL NOT NULL,
  duration_sec REAL NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  txn TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_id_desc ON messages (id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages (contact_id, id DESC);
