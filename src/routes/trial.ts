import { Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../lib/db';

export async function trialSignup(req: Request, res: Response) {
    const emailStr = req.body.email || req.query.email;

    if (!emailStr || typeof emailStr !== 'string' || !emailStr.includes('@')) {
        return res.status(400).send("Invalid email address.");
    }
    
    const email = emailStr.toLowerCase().trim();

    try {
        // Check if email already exists
        const existingCustomer = db.get('SELECT id FROM customers WHERE email = ?', email);
        if (existingCustomer) {
            return res.status(400).send(`
              <body style="background:#000; color:#fff; font-family:monospace; display:flex; justify-content:center; align-items:center; height:100vh; margin:0;">
                <div style="text-align:center; border:1px solid #333; padding:40px;">
                  <h2 style="color:var(--accent);">Email Already Registered</h2>
                  <p>You already have a Beta key! Please check your inbox.</p>
                  <a href="/" style="color:#fff; text-decoration:underline;">Back to Home</a>
                </div>
              </body>
            `);
        }

        const rawApiKey = `sk_live_${crypto.randomBytes(24).toString('hex')}`;
        const keyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');
        const keyPrefix = rawApiKey.substring(0, 16);
        
        const customerId = `cust_${crypto.randomUUID()}`;
        const apiKeyId = `key_${crypto.randomUUID()}`;
        const namespaceId = `ns_${crypto.randomUUID()}`;

        // DB Transaction
        db.run('BEGIN TRANSACTION');
        
        db.run(
            `INSERT INTO customers (id, email, name, plan) VALUES (?, ?, ?, ?)`,
            customerId, email, 'Developer', 'trial'
        );

        db.run(
            `INSERT INTO api_keys (id, customer_id, key_hash, key_prefix, label) VALUES (?, ?, ?, ?, ?)`,
            apiKeyId, customerId, keyHash, keyPrefix, 'Launch Day Beta Key'
        );

        db.run(
            `INSERT INTO namespaces (id, api_key_id, customer_id) VALUES (?, ?, ?)`,
            namespaceId, apiKeyId, customerId
        );

        db.run('COMMIT');

        // Send email via native fetch to Resend API
        await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: 'AnonID <keys@anonid.pro>',
                to: email,
                subject: 'Your AnonID Launch Day Beta Key 🔑',
                text: `Hello,\n\nThank you for joining the AnonID launch day beta. Here is your isolated namespace API key:\n\n${rawApiKey}\n\nPaste this integration snippet into your <head>:\n\n<script src="https://api.anonid.pro/anonid.js" data-key="${rawApiKey}" async></script>\n\nRead the full docs on our GitHub: https://github.com/NaijaB0T/anonid\n\nBest,\nAnonID Team`
            })
        });

        res.send(`
          <body style="background:#000; color:#fff; font-family:sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0;">
            <div style="text-align:center; border:1px solid #333; padding:40px; max-width: 500px;">
              <h2>🔑 Key Sent Successfully!</h2>
              <p>We've emailed your API key to <strong>${email}</strong>.</p>
              <p>Please check your inbox (and spam folder, just in case).</p>
              <br/>
              <a href="/" style="color:#fff; text-decoration:underline;">Back to Home</a>
            </div>
          </body>
        `);

    } catch (error) {
        try { db.run('ROLLBACK'); } catch (e) {}
        console.error("Signup error:", error);
        res.status(500).send("An error occurred generating your key. Please try again.");
    }
}
