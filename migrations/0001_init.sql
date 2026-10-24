CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  telegram_file_id TEXT NOT NULL,
  telegram_file_unique_id TEXT,
  telegram_message_id INTEGER NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS files_created_at_idx ON files(created_at DESC);
CREATE INDEX IF NOT EXISTS files_name_idx ON files(file_name);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  multipart_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'staged', 'finalizing')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS upload_parts (
  upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  PRIMARY KEY(upload_id, part_number)
);
