import { v4 as uuidv4 } from 'uuid';
import { Request, Response } from 'express';
import {
    db,
    getCachedIdentity,
    cacheIdentity,
    acquireStitchLock,
    releaseStitchLock,
} from '../lib/db';
import { AuthedRequest } from '../middleware/auth';
import { scoreFingerprint } from '../fingerprint/score';
import { fireWebhook } from '../lib/webhook';
import crypto from 'crypto';

export async function identify(req: Request, res: Response) {
    const { apiKey } = req as AuthedRequest;

    const {
        uid,             // raw UUID from visitor's cookie
        fingerprint,     // multi-signal hash from client SDK
        signals,         // optional: raw signal object for confidence scoring
        consent,         // optional: false = skip canvas stitching (GDPR mode)
    } = req.body;

    if (!uid || typeof uid !== 'string' || uid.length < 10) {
        return res.status(400).json({ error: 'uid is required (UUID string).' });
    }

    const ns = apiKey.namespaceId;
    const consentGiven = consent !== false; // default true unless explicitly false
    const canStitch = apiKey.stitchEnabled && consentGiven && !!fingerprint;

    // Hash the IP address to maintain Zero PII while enabling network clustering
    const rawIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown') as string;
    const clientIp = rawIp.split(',')[0].trim();
    const ipHash = crypto.createHash('sha256').update(`${clientIp}:${ns}`).digest('hex').substring(0, 16);

    // ─── 1. Fast path: Redis cache hit ───────────────────────────────────────
    const cached = await getCachedIdentity(ns, uid);
    if (cached) {
        return res.json({
            resolved_id: cached.r,
            uid,
            cluster_id: cached.c,
            cluster_devices: cached.d || 1,
            is_new: false,
            is_returning: true,
            confidence: 'cached',
            session_count: cached.s || 1,
        });
    }

    // ─── 2. Acquire distributed lock (prevents race conditions) ──────────────
    const lockAcquired = await acquireStitchLock(ns, uid);
    if (!lockAcquired) {
        // Another request is stitching this uid right now — wait briefly and retry from DB
        await new Promise(r => setTimeout(r, 150));
    }

    try {
        // ─── 3. DB lookup: does this uid already have a resolved identity? ────
        const existing = db.get(
            'SELECT resolved_id, cluster_id, session_count, confidence FROM identity_map WHERE namespace_id = ? AND raw_uid = ?',
            ns, uid
        );

        if (existing) {
            // Known uid — update last_seen + session_count, and graduate confidence to 'high' for returning exact matches
            const updatedConfidence = existing.session_count >= 1 ? 'high' : existing.confidence;
            
            let clusterId = existing.cluster_id;
            if (!clusterId) {
                // Backfill logic for legacy sessions created before clustering
                const networkPeer = db.get(
                    'SELECT cluster_id FROM identity_map WHERE namespace_id = ? AND last_ip = ? AND cluster_id IS NOT NULL ORDER BY last_seen DESC LIMIT 1',
                    ns, ipHash
                );
                clusterId = networkPeer?.cluster_id ? networkPeer.cluster_id : `cls_${uuidv4().replace(/-/g, '')}`;
            }

            const countRow = db.get('SELECT COUNT(DISTINCT resolved_id) as count FROM identity_map WHERE namespace_id = ? AND cluster_id = ?', ns, clusterId);
            const clusterDevices = countRow ? countRow.count : 1;

            db.run(
                'UPDATE identity_map SET last_seen = datetime(\'now\'), session_count = session_count + 1, confidence = ?, last_ip = ?, cluster_id = ? WHERE namespace_id = ? AND raw_uid = ?',
                updatedConfidence, ipHash, clusterId, ns, uid
            );
            await cacheIdentity(ns, uid, { r: existing.resolved_id, c: clusterId, d: clusterDevices, s: existing.session_count + 1 });
            return res.json({
                resolved_id: existing.resolved_id,
                cluster_id: clusterId,
                cluster_devices: clusterDevices,
                uid,
                is_new: false,
                is_returning: true,
                confidence: updatedConfidence,
                session_count: existing.session_count + 1,
            });
        }

        // ─── 4. New uid — try fingerprint stitching ───────────────────────────
        let resolvedId: string | null = null;
        let confidence = 'new';
        let mergedFrom: string | null = null;

        if (canStitch && fingerprint) {
            const stitchResult = await attemptStitch(ns, uid, fingerprint, signals, apiKey);
            if (stitchResult) {
                resolvedId = stitchResult.resolvedId;
                confidence = stitchResult.confidence;
                mergedFrom = stitchResult.mergedFrom;
            }
        }

        // ─── 5. If no stitch, create a fresh canonical identity ───────────────
        const isNew = !resolvedId;
        if (!resolvedId) {
            resolvedId = `${apiKey.idPrefix}${uuidv4()}`;
            confidence = 'new';
        }

        // ─── 5.5 Cross-Device Clustering ──────────────────────────────────────
        let clusterId = `cls_${uuidv4().replace(/-/g, '')}`;
        const networkPeer = db.get(
            'SELECT cluster_id FROM identity_map WHERE namespace_id = ? AND last_ip = ? ORDER BY last_seen DESC LIMIT 1',
            ns, ipHash
        );
        if (networkPeer && networkPeer.cluster_id) {
            clusterId = networkPeer.cluster_id; // Inherit cluster from same network
        }

        // ─── 6. Write to identity_map ─────────────────────────────────────────
        db.run(`
            INSERT INTO identity_map (namespace_id, raw_uid, resolved_id, cluster_id, last_ip, fingerprint_hash, confidence, session_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        `, ns, uid, resolvedId, clusterId, ipHash, fingerprint || null, confidence);

        const countRow = db.get('SELECT COUNT(DISTINCT resolved_id) as count FROM identity_map WHERE namespace_id = ? AND cluster_id = ?', ns, clusterId);
        const clusterDevices = countRow ? countRow.count : 1;

        await cacheIdentity(ns, uid, { r: resolvedId, c: clusterId, d: clusterDevices, s: 1 });

        // ─── 7. Fire webhook if a stitch happened ────────────────────────────
        if (!isNew && mergedFrom && apiKey.webhookUrl) {
            fireWebhook(apiKey.webhookUrl, ns, {
                event: 'identity_merged',
                canonical_id: resolvedId,
                merged_uid: uid,
                prior_uid: mergedFrom,
                confidence,
                timestamp: new Date().toISOString(),
            });
        }

        return res.json({
            resolved_id: resolvedId,
            cluster_id: clusterId,
            cluster_devices: clusterDevices,
            uid,
            is_new: isNew,
            is_returning: !isNew,
            confidence,
            session_count: 1,
        });

    } finally {
        await releaseStitchLock(ns, uid);
    }
}

// ─── Fingerprint stitching logic ──────────────────────────────────────────────

async function attemptStitch(
    ns: string,
    uid: string,
    fingerprintHash: string,
    signals: any,
    apiKey: AuthedRequest['apiKey']
): Promise<{ resolvedId: string; confidence: string; mergedFrom: string } | null> {

    // Find other sessions with the same fingerprint hash
    const matches = db.all(`
        SELECT raw_uid, resolved_id, session_count, confidence
        FROM identity_map
        WHERE namespace_id = ?
          AND fingerprint_hash = ?
          AND raw_uid != ?
        ORDER BY session_count DESC, last_seen DESC
        LIMIT 5
    `, ns, fingerprintHash, uid);

    if (matches.length === 0) return null;

    // Apply minimum session threshold (customer config)
    const minSessions = apiKey.stitchMinSessions;
    const qualifiedMatches = matches.filter((m: any) => m.session_count >= minSessions);
    if (qualifiedMatches.length === 0) return null;

    // Score confidence based on mode and signal quality
    const mode = apiKey.stitchConfidenceMode;
    const bestMatch = qualifiedMatches[0];
    const confidence = scoreFingerprint(mode, bestMatch.session_count, signals);

    // In strict mode, require high confidence
    if (mode === 'strict' && confidence !== 'high') return null;

    return {
        resolvedId: bestMatch.resolved_id,
        confidence,
        mergedFrom: bestMatch.raw_uid,
    };
}
