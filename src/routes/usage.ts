import { Request, Response } from 'express';
import { AuthedRequest } from '../middleware/auth';
import { db, redis } from '../lib/db';

export async function getUsage(req: Request, res: Response) {
    const { apiKey } = req as AuthedRequest;

    // Fetch last 30 days from SQLite
    const rows = db.all(`
        SELECT day, calls, stitches
        FROM usage_daily
        WHERE api_key_id = ?
        ORDER BY day DESC
        LIMIT 30
    `, apiKey.id);

    // Today's live count from Redis (not yet flushed to SQLite)
    const today = new Date().toISOString().slice(0, 10);
    let todayLive = 0;
    try {
        const raw = await redis.get(`anonid:usage:${apiKey.id}:${today}`);
        todayLive = raw ? parseInt(raw) : 0;
    } catch {}

    const planLimits: Record<string, number> = {
        hobby: 1000, startup: 16666, growth: 66666, scale: 333333
    };

    return res.json({
        plan: apiKey.plan,
        daily_limit: planLimits[apiKey.plan] ?? 1000,
        today: {
            date: today,
            calls: todayLive,
        },
        history: rows,
    });
}
