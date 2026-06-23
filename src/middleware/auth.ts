import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { db, checkRateLimit, getCachedApiKey, cacheApiKey, incrementUsage } from '../lib/db';

export interface AuthedRequest extends Request {
    apiKey: {
        id: string;
        customerId: string;
        namespaceId: string;
        plan: string;
        stitchEnabled: boolean;
        stitchMinSessions: number;
        stitchConfidenceMode: string;
        sessionTtlDays: number;
        idPrefix: string;
        webhookUrl: string | null;
    };
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    const rawKey = req.headers['x-api-key'] as string;
    if (!rawKey || !rawKey.startsWith('sk_')) {
        return res.status(401).json({ error: 'Missing or invalid API key. Send via X-API-Key header.' });
    }

    // Hash the raw key for lookup (never store raw keys)
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    // 1. Try Redis cache first (avoid DB on every request)
    let keyData: any = await getCachedApiKey(keyHash);

    if (!keyData) {
        // 2. DB lookup
        const row = db.get(`
            SELECT
                ak.id AS api_key_id,
                ak.customer_id,
                ak.revoked,
                c.plan,
                c.active,
                ns.id AS namespace_id,
                ns.stitch_enabled,
                ns.stitch_min_sessions,
                ns.stitch_confidence_mode,
                ns.session_ttl_days,
                ns.id_prefix,
                ns.webhook_url
            FROM api_keys ak
            JOIN customers c ON c.id = ak.customer_id
            JOIN namespaces ns ON ns.api_key_id = ak.id
            WHERE ak.key_hash = ?
        `, keyHash);

        if (!row || row.revoked || !row.active) {
            return res.status(401).json({ error: 'Invalid or revoked API key.' });
        }

        keyData = row;
        await cacheApiKey(keyHash, keyData);

        // Update last_used_at (fire-and-forget)
        db.run('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?', row.api_key_id);
    }

    // 3. Rate limit check (Redis INCR — atomic)
    const { allowed, remaining, resetInMs } = await checkRateLimit(keyData.api_key_id, keyData.plan);

    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetInMs / 1000));

    if (!allowed) {
        return res.status(429).json({
            error: 'Daily rate limit exceeded.',
            plan: keyData.plan,
            reset_in_seconds: Math.ceil(resetInMs / 1000),
        });
    }

    // 4. Attach to request + fire usage counter
    (req as AuthedRequest).apiKey = {
        id: keyData.api_key_id,
        customerId: keyData.customer_id,
        namespaceId: keyData.namespace_id,
        plan: keyData.plan,
        stitchEnabled: !!keyData.stitch_enabled,
        stitchMinSessions: keyData.stitch_min_sessions,
        stitchConfidenceMode: keyData.stitch_confidence_mode,
        sessionTtlDays: keyData.session_ttl_days,
        idPrefix: keyData.id_prefix,
        webhookUrl: keyData.webhook_url,
    };

    // Increment usage counter atomically in Redis (synced to SQLite daily by cron)
    incrementUsage(keyData.api_key_id);

    next();
}
