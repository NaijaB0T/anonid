import Database from 'better-sqlite3';
import Redis from 'ioredis';
import path from 'path';
import fs from 'fs';

// ─── SQLite ───────────────────────────────────────────────────────────────────
const DB_PATH = process.env.ANONID_DB_PATH || path.join(__dirname, '../../data/anonid.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('cache_size = -8000');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

// Run schema on startup
const schema = fs.readFileSync(path.join(__dirname, '../../schema.sql'), 'utf8');
sqlite.exec(schema);

// Prepared statement cache
const _stmts = new Map<string, Database.Statement>();
function stmt(sql: string): Database.Statement {
    if (!_stmts.has(sql)) _stmts.set(sql, sqlite.prepare(sql));
    return _stmts.get(sql)!;
}

export const db = {
    get: (sql: string, ...params: any[]) => stmt(sql).get(...params) as any,
    all: (sql: string, ...params: any[]) => stmt(sql).all(...params) as any[],
    run: (sql: string, ...params: any[]) => stmt(sql).run(...params),
};

// ─── Redis ────────────────────────────────────────────────────────────────────
// Upstash Redis (REST-compatible) or local Redis
// Set REDIS_URL in .env: 
//   Upstash: rediss://default:<password>@<host>.upstash.io:6380
//   Local:   redis://127.0.0.1:6379

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

export const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    // Upstash TLS
    tls: REDIS_URL.startsWith('rediss://') ? {} : undefined,
});

redis.on('error', (err) => {
    // Non-fatal — log but don't crash. Rate limiting degrades gracefully.
    console.error('[Redis]', err.message);
});

// ─── Redis helpers ────────────────────────────────────────────────────────────

/** Rate limit an API key: returns { allowed, remaining, resetInMs } */
export async function checkRateLimit(apiKeyId: string, plan: string): Promise<{
    allowed: boolean;
    remaining: number;
    resetInMs: number;
}> {
    const limits: Record<string, number> = {
        hobby:   1000,   // per day
        startup: 16666,  // ~500k/mo ÷ 30
        growth:  66666,  // ~2M/mo ÷ 30
        scale:   333333, // ~10M/mo ÷ 30
    };
    const dailyLimit = limits[plan] ?? limits.hobby;

    const now = new Date();
    const day = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const key = `anonid:rl:${apiKeyId}:${day}`;

    try {
        const [[, current]] = await redis
            .pipeline()
            .incr(key)
            .expire(key, 86400) // expires next day
            .exec() as any;

        const count = Number(current);
        const remaining = Math.max(0, dailyLimit - count);
        const midnight = new Date(now);
        midnight.setUTCHours(24, 0, 0, 0);
        const resetInMs = midnight.getTime() - now.getTime();

        return { allowed: count <= dailyLimit, remaining, resetInMs };
    } catch {
        // Redis down — fail open (don't block requests)
        return { allowed: true, remaining: -1, resetInMs: 0 };
    }
}

/** Cache a resolved identity (5 min TTL) */
export async function cacheIdentity(namespaceId: string, rawUid: string, payload: { r: string; c: string | null; d: number; s: number }): Promise<void> {
    try {
        await redis.set(`anonid:id:${namespaceId}:${rawUid}`, JSON.stringify(payload), 'EX', 300);
    } catch {}
}

/** Get cached resolved identity */
export async function getCachedIdentity(namespaceId: string, rawUid: string): Promise<{ r: string; c: string | null; d: number; s: number } | null> {
    try {
        const val = await redis.get(`anonid:id:${namespaceId}:${rawUid}`);
        if (!val) return null;
        if (val.startsWith('{')) return JSON.parse(val);
        return { r: val, c: null, d: 1, s: 1 };
    } catch {
        return null;
    }
}

/** Acquire a distributed lock to prevent race conditions during stitching.
 *  Returns true if lock acquired (you own it), false if someone else is processing. */
export async function acquireStitchLock(namespaceId: string, rawUid: string): Promise<boolean> {
    try {
        const result = await redis.set(
            `anonid:lock:${namespaceId}:${rawUid}`,
            '1',
            'EX',
            10,    // 10 second lock TTL (safeguard against crashes)
            'NX'   // only set if NOT exists
        );
        return result === 'OK';
    } catch {
        return true; // Redis down — proceed without lock
    }
}

/** Release the stitch lock */
export async function releaseStitchLock(namespaceId: string, rawUid: string): Promise<void> {
    try {
        await redis.del(`anonid:lock:${namespaceId}:${rawUid}`);
    } catch {}
}

/** Cache an API key lookup (1hr TTL) to avoid DB hit on every request */
export async function cacheApiKey(keyHash: string, data: object): Promise<void> {
    try {
        await redis.set(`anonid:key:${keyHash}`, JSON.stringify(data), 'EX', 3600);
    } catch {}
}

export async function getCachedApiKey(keyHash: string): Promise<object | null> {
    try {
        const raw = await redis.get(`anonid:key:${keyHash}`);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

/** Increment usage counter atomically (for billing audit) */
export async function incrementUsage(apiKeyId: string): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const key = `anonid:usage:${apiKeyId}:${day}`;
    try {
        await redis.pipeline().incr(key).expire(key, 86400 * 2).exec(); // Expire in 48 hours
    } catch {}
}

/** Atomic live request counter (Write-Behind cache style) */
export async function incrementRequestCount(namespaceId: string, rawUid: string, dbCount: number): Promise<number> {
    try {
        const key = `anonid:reqs:${namespaceId}:${rawUid}`;
        const [[, count]] = await redis.pipeline().incr(key).expire(key, 86400 * 30).exec() as any;
        
        // If Redis just started tracking this, initialize it with the historical DB count
        if (Number(count) === 1 && dbCount > 1) {
            await redis.pipeline().incrby(key, dbCount - 1).expire(key, 86400 * 30).exec();
            return dbCount;
        }
        return Number(count);
    } catch {
        return dbCount + 1; // Fallback if Redis fails
    }
}
