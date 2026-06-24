-- AnonID — Isolated SQLite schema
-- One database, fully isolated from all other projects

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -8000; -- 8MB page cache
PRAGMA foreign_keys = ON;

-- ─── Customers ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
    id          TEXT PRIMARY KEY,             -- cust_uuid
    email       TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    plan        TEXT NOT NULL DEFAULT 'hobby', -- hobby | startup | growth | scale
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    active      INTEGER NOT NULL DEFAULT 1
);

-- ─── API Keys ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
    id            TEXT PRIMARY KEY,           -- key_uuid
    customer_id   TEXT NOT NULL REFERENCES customers(id),
    key_hash      TEXT NOT NULL UNIQUE,       -- SHA-256 of the raw key (never store raw)
    key_prefix    TEXT NOT NULL,              -- first 8 chars for display: "sk_live_abc12345..."
    label         TEXT,                       -- friendly name
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at  TEXT,
    revoked       INTEGER NOT NULL DEFAULT 0
);

-- ─── Namespaces (one per API key, isolates customer data) ────────────────────
CREATE TABLE IF NOT EXISTS namespaces (
    id            TEXT PRIMARY KEY,           -- ns_uuid
    api_key_id    TEXT NOT NULL REFERENCES api_keys(id),
    customer_id   TEXT NOT NULL REFERENCES customers(id),
    -- Per-customer config
    stitch_enabled           INTEGER NOT NULL DEFAULT 1,   -- enable canvas stitching
    stitch_min_sessions      INTEGER NOT NULL DEFAULT 2,   -- min prior sessions to trust stitch
    stitch_confidence_mode   TEXT NOT NULL DEFAULT 'medium', -- strict | medium | loose
    session_ttl_days         INTEGER NOT NULL DEFAULT 180, -- inactivity before new identity
    id_prefix                TEXT NOT NULL DEFAULT 'uid_', -- prefix on resolved IDs
    webhook_url              TEXT,                          -- fires on identity_merged events
    created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Identity Map ─────────────────────────────────────────────────────────────
-- Maps raw browser UUIDs → canonical resolved identity
-- One customer's data is completely isolated by namespace_id
CREATE TABLE IF NOT EXISTS identity_map (
    namespace_id    TEXT NOT NULL,
    raw_uid         TEXT NOT NULL,            -- UUID from the customer's visitor cookie
    resolved_id     TEXT NOT NULL,            -- canonical ID (either raw_uid or merged target)
    cluster_id      TEXT,                     -- network-level cluster ID (for cross-device)
    last_ip         TEXT,                     -- IP address hash for clustering
    fingerprint_hash TEXT,                    -- multi-signal fingerprint hash
    confidence      TEXT NOT NULL DEFAULT 'new', -- new | low | medium | high
    session_count   INTEGER NOT NULL DEFAULT 1,
    first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (namespace_id, raw_uid)
);

CREATE INDEX IF NOT EXISTS idx_identity_resolved
    ON identity_map(namespace_id, resolved_id);

CREATE INDEX IF NOT EXISTS idx_identity_fingerprint
    ON identity_map(namespace_id, fingerprint_hash)
    WHERE fingerprint_hash IS NOT NULL;

-- ─── Usage Counters (daily snapshots for billing audit trail) ─────────────────
CREATE TABLE IF NOT EXISTS usage_daily (
    api_key_id  TEXT NOT NULL,
    day         TEXT NOT NULL,                -- YYYY-MM-DD
    calls       INTEGER NOT NULL DEFAULT 0,
    stitches    INTEGER NOT NULL DEFAULT 0,   -- how many identity merges occurred
    PRIMARY KEY (api_key_id, day)
);

-- ─── Webhook Delivery Log ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_log (
    id              TEXT PRIMARY KEY,
    namespace_id    TEXT NOT NULL,
    event_type      TEXT NOT NULL,            -- identity_merged
    payload         TEXT NOT NULL,            -- JSON
    status          INTEGER,                  -- HTTP status from customer endpoint
    attempted_at    TEXT NOT NULL DEFAULT (datetime('now')),
    delivered       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS semantic_intents (
    namespace_id TEXT NOT NULL,
    raw_uid TEXT NOT NULL,
    cluster_id TEXT NOT NULL,
    intent_string TEXT,
    vector_json TEXT,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (namespace_id, raw_uid)
);
CREATE INDEX IF NOT EXISTS idx_semantic_cluster ON semantic_intents(namespace_id, cluster_id);
