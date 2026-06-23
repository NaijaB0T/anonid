import { Request, Response } from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { sendApiKeyEmail } from '../lib/email';

/**
 * Handles incoming payment webhooks (e.g., from Lemon Squeezy or Stripe).
 * When a subscription is created:
 * 1. Creates a Customer record
 * 2. Generates a raw API key + hash
 * 3. Creates a Namespace
 * 4. Emails the raw key to the customer
 */
export async function handlePaymentWebhook(req: Request, res: Response) {
    // In production, you MUST verify the webhook signature here!
    // Example: const signature = req.headers['x-signature']; ...

    try {
        const payload = req.body;
        
        // This expects a generic payload. Adapt based on your exact payment provider.
        // E.g., Lemon Squeezy sends: { meta: { event_name: 'subscription_created' }, data: { attributes: { user_email: '...' } } }
        
        const eventName = payload.meta?.event_name || payload.type;
        
        if (eventName !== 'subscription_created' && eventName !== 'order_created') {
            return res.json({ received: true, ignored: true });
        }

        const email = payload.data?.attributes?.user_email || payload.email;
        const name = payload.data?.attributes?.user_name || payload.name || 'Developer';
        const plan = 'startup'; // Map product ID to plan tier here

        if (!email) {
            return res.status(400).json({ error: 'Missing email in payload' });
        }

        // 1. Create Customer
        const customerId = 'cust_' + uuidv4().replace(/-/g, '');
        db.prepare(`
            INSERT INTO customers (id, email, name, plan)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET active = 1, plan = excluded.plan
        `).run(customerId, email, name, plan);

        // Fetch the actual customer ID (in case of conflict/upsert)
        const customer = db.prepare('SELECT id FROM customers WHERE email = ?').get(email) as any;

        // 2. Generate API Key
        const rawKey = 'sk_live_' + crypto.randomBytes(24).toString('hex');
        const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
        const keyPrefix = rawKey.slice(0, 14);
        const keyId = 'key_' + uuidv4().replace(/-/g, '');

        db.prepare(`
            INSERT INTO api_keys (id, customer_id, key_hash, key_prefix, label)
            VALUES (?, ?, ?, ?, ?)
        `).run(keyId, customer.id, keyHash, keyPrefix, 'Default Key');

        // 3. Create Namespace
        const nsId = 'ns_' + uuidv4().replace(/-/g, '');
        db.prepare(`
            INSERT INTO namespaces (id, api_key_id, customer_id)
            VALUES (?, ?, ?)
        `).run(nsId, keyId, customer.id);

        console.log(`[Webhook] Provisioned new account for ${email}. Sending email...`);

        // 4. Email the key
        await sendApiKeyEmail(email, rawKey);

        return res.json({ success: true });
    } catch (err) {
        console.error('[Webhook] Error processing payment webhook:', err);
        return res.status(500).json({ error: 'Internal webhook error' });
    }
}
