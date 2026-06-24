import { Worker } from 'worker_threads';
import path from 'path';

// Point to the compiled .js file in the dist/ folder at runtime
const workerPath = path.resolve(__dirname, './vector-worker.js');
const worker = new Worker(workerPath);

let msgId = 0;
const pending = new Map<number, (vec: number[]) => void>();

worker.on('message', (msg) => {
    if (msg.error) {
        console.error('[VectorWorker] Inference Error:', msg.error);
    }
    const resolve = pending.get(msg.id);
    if (resolve && msg.vector) {
        resolve(msg.vector);
        pending.delete(msg.id);
    }
});

/** Offloads ONNX embedding math to a dedicated background Worker Thread */
export async function getEmbedding(text: string): Promise<number[]> {
    return new Promise((resolve) => {
        const id = ++msgId;
        pending.set(id, resolve);
        worker.postMessage({ id, text });
    });
}

/** Calculates Cosine Similarity between two vectors (1.0 = identical, 0.0 = orthogonal) */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
