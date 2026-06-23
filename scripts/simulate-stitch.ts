import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

const API_KEY = 'sk_live_d4995e39ebcf2a254fa6bfdf24accc918aca630ed13acbde';
const URL = 'http://127.0.0.1:5050/v1/identify';

async function identify(uid: string, fingerprint: string) {
    const res = await fetch(URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': API_KEY
        },
        body: JSON.stringify({ uid, fingerprint, signals: { webgl_renderer: 'Simulated RTX 4090' } })
    });
    return res.json();
}

async function run() {
    console.log('🧪 Simulating Anonymous Identity Stitching...\n');

    // Generate a fixed fingerprint to represent the user's specific device
    const deviceFingerprint = crypto.createHash('sha256').update('MacBook Pro M2 - Safari 17.1 - ' + Date.now()).digest('hex');

    // 1. FIRST VISIT (Monday)
    const browser1_uid = uuidv4();
    console.log(`[Monday] User visits for the first time.`);
    console.log(`Browser sets cookie: UID = ${browser1_uid}`);
    
    let result = await identify(browser1_uid, deviceFingerprint);
    console.log(`API Response:`, result);
    console.log(`-> Assigned Canonical ID: ${result.resolved_id}\n`);

    const originalResolvedId = result.resolved_id;

    // Simulate time passing (clearing the 5-minute Redis session cache)
    const { redis } = require('../src/lib/db');
    await redis.flushall();

    // To simulate a realistic scenario and satisfy the 'stitchMinSessions' setting (currently set to 2 in our DB),
    // the user needs to return to the site normally before clearing cookies.
    // 2. SECOND VISIT (Wednesday)
    console.log(`[Wednesday] User returns normally (cookie intact).`);
    result = await identify(browser1_uid, deviceFingerprint);
    console.log(`API Response:`, result);
    console.log(`-> Still mapped to: ${result.resolved_id}\n`);

    // 3. THE COOKIE CLEAR (Friday)
    console.log(`[Friday] USER CLEARS COOKIES AND RETURNS.`);
    const browser2_uid = uuidv4();
    console.log(`Browser sets NEW cookie: UID = ${browser2_uid}`);
    console.log(`(But the device hardware signature remains the same)`);

    result = await identify(browser2_uid, deviceFingerprint);
    console.log(`API Response:`, result);
    
    console.log(`\n🎉 STITCH RESULT:`);
    if (result.resolved_id === originalResolvedId) {
        console.log(`✅ SUCCESS! The new cookie (${browser2_uid}) was instantly stitched back to the original identity (${result.resolved_id}).`);
        console.log(`Confidence: ${result.confidence}`);
    } else {
        console.log(`❌ FAILED. Got a new identity: ${result.resolved_id}`);
    }
}

run();
