export async function sendApiKeyEmail(email: string, apiKey: string) {
    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) {
        console.warn('[Email] RESEND_API_KEY not set. Cannot send email to:', email);
        console.log('[Email] Simulated Send -> Key:', apiKey);
        return;
    }

    const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
        <h2>Welcome to AnonID! 🎉</h2>
        <p>Thank you for subscribing. Here is your production API key:</p>
        <div style="background: #f4f4f4; padding: 15px; border-radius: 6px; font-family: monospace; font-size: 16px; margin: 20px 0;">
            ${apiKey}
        </div>
        <p><strong>Next steps:</strong></p>
        <ol>
            <li>Add the <code>anonid.js</code> script to your website.</li>
            <li>Use the API key above in the <code>data-key</code> attribute.</li>
            <li>Read the docs at <a href="https://anonid.pro">anonid.pro</a> for webhook setup.</li>
        </ol>
        <p>Keep this key safe! Do not commit it to public repositories.</p>
        <p>- The AnonID Team</p>
    </div>
    `;

    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${RESEND_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: 'AnonID <support@anonid.pro>',
                to: [email],
                subject: 'Your AnonID API Key',
                html
            })
        });

        if (!res.ok) {
            console.error('[Email] Failed to send email:', await res.text());
        }
    } catch (err) {
        console.error('[Email] Error sending email:', err);
    }
}
