import { Request, Response } from 'express';
import { db } from '../lib/db';
import { AuthedRequest } from '../middleware/auth';
import { getEmbedding, cosineSimilarity } from '../lib/vector';

export async function trackIntent(req: Request, res: Response) {
    const { apiKey } = req as AuthedRequest;
    const { uid, tags } = req.body;

    if (!uid || !tags || !Array.isArray(tags)) {
        return res.status(400).json({ error: 'uid and tags array are required' });
    }

    const ns = apiKey.namespaceId;
    const intentString = tags.join(' ').toLowerCase();

    // 1. Get user's current cluster_id
    const user = db.get('SELECT resolved_id, cluster_id FROM identity_map WHERE namespace_id = ? AND raw_uid = ?', ns, uid);
    if (!user || !user.cluster_id) {
        return res.status(404).json({ error: 'Identity not found. Call /identify first.' });
    }

    // 2. Generate Embedding Vector from Intent String
    const vector = await getEmbedding(intentString);
    const vectorJson = JSON.stringify(vector);

    // 3. Save to semantic_intents
    db.run(`
        INSERT INTO semantic_intents (namespace_id, raw_uid, cluster_id, intent_string, vector_json, last_updated)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(namespace_id, raw_uid) DO UPDATE SET 
        intent_string = excluded.intent_string, 
        vector_json = excluded.vector_json,
        last_updated = datetime('now')
    `, ns, uid, user.cluster_id, intentString, vectorJson);

    // 4. Scoped Vector Search (Compare against others in the exact same household, active within the last 15 minutes)
    const peers = db.all(`
        SELECT s.raw_uid, i.resolved_id, s.vector_json 
        FROM semantic_intents s
        JOIN identity_map i ON s.namespace_id = i.namespace_id AND s.raw_uid = i.raw_uid
        WHERE s.namespace_id = ? 
        AND s.cluster_id = ? 
        AND s.raw_uid != ?
        AND s.last_updated > datetime('now', '-15 minutes')
    `, ns, user.cluster_id, uid);

    let bestMatch = null;
    let highestSim = 0;

    for (const peer of peers) {
        if (!peer.vector_json) continue;
        const peerVec = JSON.parse(peer.vector_json);
        const sim = cosineSimilarity(vector, peerVec);
        if (sim > highestSim) {
            highestSim = sim;
            bestMatch = peer;
        }
    }

    // 5. Semantic Stitch (Threshold: 0.90)
    if (highestSim >= 0.90 && bestMatch && bestMatch.resolved_id !== user.resolved_id) {
        // Enforce Multiple-Signal Validation (Soft Association Table)
        // Sort UIDs so A is always less than B to prevent duplicate bidirectional rows
        const uidA = uid < bestMatch.raw_uid ? uid : bestMatch.raw_uid;
        const uidB = uid > bestMatch.raw_uid ? uid : bestMatch.raw_uid;
        
        db.run(`
            INSERT INTO soft_associations (namespace_id, uid_a, uid_b, overlap_count, last_overlap)
            VALUES (?, ?, ?, 1, datetime('now'))
            ON CONFLICT(namespace_id, uid_a, uid_b) DO UPDATE SET 
            overlap_count = overlap_count + 1,
            last_overlap = datetime('now')
        `, ns, uidA, uidB);

        const assoc = db.get('SELECT overlap_count FROM soft_associations WHERE namespace_id = ? AND uid_a = ? AND uid_b = ?', ns, uidA, uidB);

        // Require 3 highly-similar semantic overlaps before executing a destructive DB merge
        if (assoc && assoc.overlap_count >= 3) {
            db.run(
                'UPDATE identity_map SET resolved_id = ?, confidence = ? WHERE namespace_id = ? AND raw_uid = ?',
                bestMatch.resolved_id, 'semantic_stitch', ns, uid
            );
            return res.json({
                status: 'stitched',
                resolved_id: bestMatch.resolved_id,
                confidence: 'semantic_stitch',
                similarity: highestSim
            });
        }

        return res.json({
            status: 'soft_association',
            overlap_count: assoc?.overlap_count || 1,
            similarity: highestSim
        });
    }

    return res.json({
        status: 'tracked',
        similarity_checked: peers.length,
        max_similarity: highestSim
    });
}
