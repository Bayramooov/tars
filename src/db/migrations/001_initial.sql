-- The tars schema. Change it with a new numbered file; never edit one that has shipped.

CREATE TABLE messages (
    chat_id          INTEGER NOT NULL,
    message_id       INTEGER NOT NULL,
    user_id          INTEGER NOT NULL,
    username         TEXT,
    first_name       TEXT,
    direction        TEXT NOT NULL CHECK (direction IN ('in','out')),
    timestamp        TEXT NOT NULL,
    text             TEXT NOT NULL,
    reply_to_id      INTEGER,
    reply_to_text    TEXT,
    edited           INTEGER DEFAULT 0,
    deleted          INTEGER DEFAULT 0,
    raw_update_json  TEXT,
    reactions        TEXT,               -- JSON {"👍": [user_id, ...]}; NULL when none
    consumed         INTEGER DEFAULT 0,  -- handed to Claude Code; inbound rows still at 0 are replayed at boot
    processed        INTEGER DEFAULT 0,  -- its turn finished cleanly; only these enter a restored-context digest
    PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_messages_user ON messages(user_id);
-- Only unconsumed inbound rows, so the boot replay query stays instant.
CREATE INDEX idx_messages_unconsumed ON messages(consumed) WHERE consumed = 0 AND direction = 'in';

CREATE TABLE users (
    chat_id           INTEGER NOT NULL,
    user_id           INTEGER NOT NULL,
    username          TEXT,
    first_name        TEXT,
    join_date         TEXT NOT NULL,
    last_message_date TEXT,
    message_count     INTEGER DEFAULT 0,
    PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE tool_calls (
    id             INTEGER PRIMARY KEY,
    tool_name      TEXT NOT NULL,
    args_json      TEXT NOT NULL,
    result_json    TEXT,
    error          TEXT,
    duration_ms    INTEGER,
    created_at     TEXT NOT NULL
);

-- Inbound DM limiter: one row per user per fixed time bucket.
CREATE TABLE rate_limits (
    user_id       INTEGER NOT NULL,
    bucket_start  INTEGER NOT NULL,            -- unix seconds, floored to the bucket
    count         INTEGER NOT NULL DEFAULT 0,
    notice_sent   INTEGER NOT NULL DEFAULT 0,  -- this bucket's one "too fast" notice went out
    PRIMARY KEY (user_id, bucket_start)
);

CREATE TABLE reminders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id       INTEGER NOT NULL,
    user_id       INTEGER NOT NULL,
    text          TEXT NOT NULL,
    trigger_at    TEXT NOT NULL,  -- UTC
    cron_expr     TEXT,           -- NULL for one-shot
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'sent', 'cancelled')),
    created_at    TEXT NOT NULL,
    auto_seed_key TEXT            -- set on rows seeded at boot; these can't be cancelled from chat
);

CREATE INDEX idx_reminders_due ON reminders(status, trigger_at);
CREATE INDEX idx_reminders_auto_seed_key ON reminders(auto_seed_key);

-- Messages from chats that failed the access gate, kept out of `messages`.
CREATE TABLE unauthorized_messages (
    id            INTEGER PRIMARY KEY,
    chat_id       INTEGER NOT NULL,
    chat_type     TEXT,
    message_id    INTEGER NOT NULL,
    user_id       INTEGER NOT NULL,
    username      TEXT,
    first_name    TEXT,
    timestamp     TEXT NOT NULL,
    text          TEXT NOT NULL,
    refusal_sent  INTEGER NOT NULL DEFAULT 0  -- this row triggered the chat's one-time refusal reply
);

CREATE INDEX idx_unauthorized_messages_chat ON unauthorized_messages(chat_id);
CREATE INDEX idx_unauthorized_messages_timestamp ON unauthorized_messages(timestamp);
