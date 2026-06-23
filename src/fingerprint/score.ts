/**
 * Fingerprint confidence scorer.
 * 
 * Given a stitch mode (strict/medium/loose), the prior session count of the
 * matching record, and the raw signals object, returns a confidence level.
 * 
 * The raw signals let us score quality of the match — e.g. if WebGL renderer
 * string is present and matched, that's a strong signal since GPU strings are
 * highly device-specific.
 */

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'new';

export function scoreFingerprint(
    mode: string,
    priorSessionCount: number,
    signals?: Record<string, any>
): ConfidenceLevel {
    // Base score from session count (more prior sessions = more trustworthy)
    let score = 0;

    if (priorSessionCount >= 10) score += 40;
    else if (priorSessionCount >= 5) score += 25;
    else if (priorSessionCount >= 2) score += 15;
    else score += 5;

    // Signal quality scoring (if client sent raw signals)
    if (signals) {
        // WebGL GPU renderer is highly device-specific — strongest signal
        if (signals.webgl_renderer && signals.webgl_renderer.length > 10) score += 25;

        // Audio fingerprint is OS/driver specific
        if (signals.audio_hash) score += 20;

        // Canvas varies per GPU/driver/OS font rendering
        if (signals.canvas_hash) score += 15;

        // Hardware concurrency + memory narrow down device class
        if (signals.cpu_cores && signals.memory_gb) score += 10;

        // Timezone + screen resolution help but are weak alone
        if (signals.timezone) score += 5;
        if (signals.screen) score += 5;

        // Platform string (Win32, MacIntel, Linux x86_64)
        if (signals.platform) score += 5;
    }

    // Map score to confidence level
    if (score >= 70) return 'high';
    if (score >= 40) return 'medium';
    if (score >= 20) return 'low';
    return 'new';
}
