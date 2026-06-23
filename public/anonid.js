/**
 * AnonID Client SDK v1.0
 * Drop-in anonymous cross-session identity stitching.
 * 
 * Usage:
 *   <script src="https://api.anonid.pro/sdk/anonid.js" data-key="sk_live_..." async></script>
 * 
 * Or programmatically:
 *   AnonID.init({ apiKey: 'sk_live_...', onReady: ({ resolved_id, is_returning }) => {} })
 */
(function (global) {
    'use strict';

    const COOKIE_NAME = '__anid';
    const COOKIE_TTL  = 365 * 24 * 60 * 60; // 1 year in seconds
    const API_BASE    = 'https://api.anonid.pro'; // customers can override

    // ─── Cookie helpers ────────────────────────────────────────────────────────
    function getCookie(name) {
        const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : null;
    }

    function setCookie(name, value, maxAge) {
        const domain = location.hostname === 'localhost'
            ? 'localhost'
            : '.' + location.hostname.split('.').slice(-2).join('.');
        document.cookie = [
            name + '=' + encodeURIComponent(value),
            'max-age=' + maxAge,
            'path=/',
            'domain=' + domain,
            'SameSite=Lax',
            location.protocol === 'https:' ? 'Secure' : '',
        ].filter(Boolean).join('; ');
    }

    // ─── UUID generator ────────────────────────────────────────────────────────
    function uuid() {
        if (crypto && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    // ─── Multi-signal fingerprinting ───────────────────────────────────────────
    async function collectSignals() {
        const signals = {};

        // 1. CANVAS — GPU/driver-specific pixel rendering
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 240; canvas.height = 60;
            const ctx = canvas.getContext('2d');
            // Multiple drawing ops — each produces slightly different output per GPU/driver
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = '#f0a';
            ctx.fillRect(100, 5, 80, 25);
            ctx.fillStyle = '#069';
            ctx.font = 'bold 13px "Arial Unicode MS", Arial, sans-serif';
            ctx.fillText('AnonID \uD83D\uDD12 Cwm fjordbank 5.14', 2, 18);
            ctx.fillStyle = 'rgba(80, 200, 40, 0.75)';
            ctx.font = '15px Georgia, serif';
            ctx.fillText('AnonID \uD83D\uDD12 Cwm fjordbank 5.14', 4, 42);
            // Arc for GPU rasterization difference
            ctx.beginPath();
            ctx.arc(120, 30, 20, 0, Math.PI * 2);
            ctx.strokeStyle = '#f60';
            ctx.lineWidth = 2;
            ctx.stroke();
            signals.canvas_hash = await sha256(canvas.toDataURL());
        } catch (_) {}

        // 2. WEBGL — GPU vendor/renderer strings + shader precision
        // The UNMASKED_RENDERER_WEBGL string includes the exact GPU model (e.g. "ANGLE (NVIDIA,
        // NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)")
        try {
            const offscreen = document.createElement('canvas');
            const gl = offscreen.getContext('webgl') || offscreen.getContext('experimental-webgl');
            if (gl) {
                const dbg = gl.getExtension('WEBGL_debug_renderer_info');
                signals.webgl_vendor   = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)   : gl.getParameter(gl.VENDOR);
                signals.webgl_renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
                signals.webgl_version  = gl.getParameter(gl.VERSION);
                signals.webgl_shading  = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);

                // Shader precision — differs per GPU driver
                const vhf = gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.HIGH_FLOAT);
                signals.webgl_vhf = vhf ? vhf.precision + '/' + vhf.rangeMin + '/' + vhf.rangeMax : null;
                const fhf = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
                signals.webgl_fhf = fhf ? fhf.precision + '/' + fhf.rangeMin + '/' + fhf.rangeMax : null;

                // Supported extensions list (differs by GPU/driver)
                const exts = gl.getSupportedExtensions() || [];
                signals.webgl_exts_count = exts.length;
            }
        } catch (_) {}

        // 3. AUDIO — OfflineAudioContext produces slightly different float sums
        // per OS audio driver stack. Works silently (no sound played).
        try {
            const AudioCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
            if (AudioCtx) {
                const ctx = new AudioCtx(1, 44100, 44100);
                const osc = ctx.createOscillator();
                const analyser = ctx.createAnalyser();
                const gain = ctx.createGain();
                gain.gain.value = 0; // completely silent

                osc.type = 'triangle';
                osc.frequency.value = 10000;
                osc.connect(analyser);
                analyser.connect(ctx.destination);
                osc.start(0);

                const buffer = await ctx.startRendering();
                const data = buffer.getChannelData(0);
                let sum = 0;
                // Sample every 100th value for speed (still produces unique sum)
                for (let i = 0; i < data.length; i += 100) sum += Math.abs(data[i]);
                signals.audio_hash = sum.toFixed(10);
            }
        } catch (_) {}

        // 4. HARDWARE — CPU core count + device memory class
        // navigator.hardwareConcurrency: actual logical CPU count (2,4,8,12,16...)
        // navigator.deviceMemory: device RAM in powers of 2 (0.25, 0.5, 1, 2, 4, 8)
        signals.cpu_cores  = navigator.hardwareConcurrency  || 0;
        signals.memory_gb  = navigator.deviceMemory         || 0;
        signals.touch_pts  = navigator.maxTouchPoints       || 0;

        // 5. DISPLAY
        signals.screen = screen.width + 'x' + screen.height + 'x' + screen.colorDepth;
        signals.dpr    = window.devicePixelRatio            || 1;

        // 6. SYSTEM
        signals.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        signals.platform = navigator.platform               || '';
        signals.lang     = navigator.language               || '';

        // 7. COMBINED HASH — single string sent to the API
        const combined = JSON.stringify(signals);
        const fingerprint = await sha256(combined);

        return { fingerprint, signals };
    }

    // ─── SHA-256 via Web Crypto ────────────────────────────────────────────────
    async function sha256(str) {
        const buf = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(str)
        );
        return Array.from(new Uint8Array(buf))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    // ─── Main init ────────────────────────────────────────────────────────────
    async function init(options) {
        const {
            apiKey,
            apiBase    = API_BASE,
            consent    = true,       // set false for GDPR strict mode (no canvas stitch)
            onReady    = null,       // callback: ({ resolved_id, is_returning, confidence }) => {}
            onError    = null,       // callback: (err) => {}
            cookieName = COOKIE_NAME,
        } = options;

        if (!apiKey) return console.error('[AnonID] apiKey is required.');

        // 1. Get or create raw uid
        let uid = getCookie(cookieName);
        if (!uid) {
            uid = uuid();
            setCookie(cookieName, uid, COOKIE_TTL);
        }

        // 2. Collect multi-signal fingerprint (async, parallel)
        let fingerprint = null;
        let signals = null;
        if (consent) {
            try {
                const fp = await collectSignals();
                fingerprint = fp.fingerprint;
                signals = fp.signals;
            } catch (_) {}
        }

        // 3. Call the identify API
        try {
            const res = await fetch(apiBase + '/v1/identify', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': apiKey,
                },
                body: JSON.stringify({ uid, fingerprint, signals, consent }),
            });

            if (!res.ok) throw new Error('HTTP ' + res.status);

            const data = await res.json();

            // 4. Expose globally + fire callback
            global.__anonId = data;
            global.dispatchEvent(new CustomEvent('anonid:ready', { detail: data }));
            if (typeof onReady === 'function') onReady(data);

        } catch (err) {
            if (typeof onError === 'function') onError(err);
            // Fallback: expose uid only (degraded mode)
            const fallback = { resolved_id: uid, uid, is_new: null, is_returning: null, confidence: 'offline' };
            global.__anonId = fallback;
            global.dispatchEvent(new CustomEvent('anonid:ready', { detail: fallback }));
        }
    }

    // ─── Auto-init from data-key attribute ────────────────────────────────────
    function autoInit() {
        const script = document.currentScript
            || document.querySelector('script[data-key]');
        if (script && script.dataset.key) {
            init({
                apiKey:  script.dataset.key,
                apiBase: script.dataset.base || API_BASE,
                consent: script.dataset.consent !== 'false',
            });
        }
    }

    // ─── Public API ───────────────────────────────────────────────────────────
    global.AnonID = { init, collectSignals };

    // Auto-init if script tag has data-key
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit);
    } else {
        autoInit();
    }

})(window);
