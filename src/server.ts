import express from 'express';
import { authMiddleware } from './middleware/auth';
import { identify } from './routes/identify';
import { getUsage } from './routes/usage';
import { handlePaymentWebhook } from './routes/webhooks';
import { provisionGatewayAccount } from './routes/admin';
import { trackIntent } from './routes/track';
import { trialSignup } from './routes/trial';

const app = express();
const PORT = process.env.PORT || 5050;

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// CORS — allow customer sites to call from browser
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Health
app.get('/health', (_, res) => res.json({ ok: true, service: 'anonid', ts: new Date().toISOString() }));

// Serve the client SDK & Landing Page docs
app.use('/', express.static('public'));

// Webhooks and Public Trial Endpoint
app.post('/webhooks/payment', handlePaymentWebhook);
app.post('/v1/trial/signup', trialSignup);

// Admin Routes (Secured by ADMIN_API_SECRET)
app.post('/v1/admin/customers', provisionGatewayAccount);

// API routes — all require auth
app.post('/v1/identify', authMiddleware, identify);
app.post('/v1/track', authMiddleware, trackIntent);
app.get('/v1/usage', authMiddleware, getUsage);

app.listen(PORT, () => {
    console.log(`[AnonID] Running on port ${PORT}`);
});
