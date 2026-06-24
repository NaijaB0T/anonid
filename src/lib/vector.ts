import { pipeline } from '@xenova/transformers';

let extractor: any = null;

/** Returns a 384-dimensional vector representing the text intent */
export async function getEmbedding(text: string): Promise<number[]> {
    if (!extractor) {
        // Downloads and caches Xenova/all-MiniLM-L6-v2 on first run
        extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
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
