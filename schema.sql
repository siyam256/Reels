CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admins (user_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS channels (chat_id TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS pending_polls (
 id TEXT PRIMARY KEY, owner_chat_id TEXT NOT NULL, question TEXT NOT NULL,
 options_json TEXT NOT NULL, correct_option_id INTEGER NOT NULL,
 explanation TEXT NOT NULL, original_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS edit_requests (
 prompt_message_id TEXT PRIMARY KEY, owner_chat_id TEXT NOT NULL,
 poll_id TEXT NOT NULL, edit_type TEXT NOT NULL, option_index INTEGER
);
INSERT OR IGNORE INTO settings(key,value) VALUES ('prefix','[POLL]');
INSERT OR IGNORE INTO settings(key,value) VALUES ('explanation','Join t.me/link');
INSERT OR IGNORE INTO admins(user_id) VALUES ('7145991193');
