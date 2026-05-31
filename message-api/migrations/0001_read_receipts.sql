CREATE TABLE IF NOT EXISTS read_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_read_receipts_id_desc ON read_receipts (id DESC);
