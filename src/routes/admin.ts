import { Request, Response } from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';

/**
 * Auto-provisioning endpoint for Gateways (Shopify, WooCommerce, etc.)
 * Protected by ADMIN_API_SECRET.
 */
export async function provisionGatewayAccount(req: Request, res: Response) {
    const authHeader = req.headers.authorization;
    const adminSecret = process.env.ADMIN_API_SECRET;

    if (!adminSecret || authHeader !== `Bearer ${adminSecret}`) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing Master Admin Secret.' });
    }

    const { email, name, plan = 'startup', webhook_url } = req.body;

    if (!email || !name) {
        return res.status(400).json({ error: 'email and name are required.' });
    }

    try {
        // 1. Create Customer
        const customerId = 'cust_' + uuidv4().replace(/-/g, '');
        db.prepare(`
            INSERT INTO customers (id, email, name, plan)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET active = 1, plan = excluded.plan
        `).run(customerId, email, name, plan);

        const customer = db.prepare('SELECT id FROM customers WHERE email = ?').get(email) as any;

        // 2. Generate API Key
        const rawKey = 'sk_live_' + crypto.randomBytes(24).toString('hex');
        const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
        const keyPrefix = rawKey.slice(0, 14);
        const keyId = 'key_' + uuidv4().replace(/-/g, '');

        db.prepare(`
            INSERT INTO api_keys (id, customer_id, key_hash, key_prefix, label)
            VALUES (?, ?, ?, ?, ?)
        `).run(keyId, customer.id, keyHash, keyPrefix, 'Gateway Auto-Provisioned Key');

        // 3. Create Namespace
        const nsId = 'ns_' + uuidv4().replace(/-/g, '');
        db.prepare(`
            INSERT INTO namespaces (id, api_key_id, customer_id, webhook_url)
            VALUES (?, ?, ?, ?)
        `).run(nsId, keyId, customer.id, webhook_url || null);

        console.log(`[Admin] Auto-provisioned account for ${email} via Gateway.`);

        // 4. Return the Raw Key and Namespace ID so the gateway can store it
        return res.json({
            success: true,
            api_key: rawKey,
            namespace_id: nsId
        });
    } catch (err) {
        console.error('[Admin] Provisioning error:', err);
        return res.status(500).json({ error: 'Internal server error during provisioning' });
    }
}
