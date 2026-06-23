import { db } from '../lib/db';

/**
 * Fires a webhook to the customer's endpoint.
 * Fire-and-forget — does not block the identify response.
 * Logs delivery status to webhook_log for retry support.
 */
export function fireWebhook(url: string, namespaceId: string, payload: object): void {
    const body = JSON.stringify(payload);
    const logId = crypto.randomUUID();

    // Log attempt
    db.run(`
        INSERT INTO webhook_log (id, namespace_id, event_type, payload)
        VALUES (?, ?, ?, ?)
    `, logId, namespaceId, (payload as any).event, body);

    // Fire async — don't await
    (async () => {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'AnonID-Webhooks/1.0',
                    'X-AnonID-Event': (payload as any).event,
                },
                body,
                signal: AbortSignal.timeout(5000),
            });
            db.run(
                'UPDATE webhook_log SET status = ?, delivered = 1 WHERE id = ?',
                res.status, logId
            );
        } catch (err: any) {
            db.run(
                'UPDATE webhook_log SET status = 0, delivered = 0 WHERE id = ?',
                logId
            );
        }
    })();
}
