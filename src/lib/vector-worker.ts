import { parentPort } from 'worker_threads';
import { pipeline } from '@xenova/transformers';

let extractor: any = null;

parentPort?.on('message', async (message) => {
    try {
        if (!extractor) {
            // Lazy load the model on the first request in the background thread
            extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        }
        
        const { id, text } = message;
        // Generate the 384-dimensional vector
        const output = await extractor(text, { pooling: 'mean', normalize: true });
        
        // Send it back to the main Express event loop
        parentPort?.postMessage({ id, vector: Array.from(output.data) });
    } catch (error: any) {
        parentPort?.postMessage({ id: message.id, error: error.message });
    }
});
