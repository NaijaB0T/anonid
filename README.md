# AnonID: Open Source, Self-Hosted Identity Resolution Engine

An open-source, lightweight alternative to Fingerprint.com built with Express, SQLite, and Redis. It stitches anonymous visitor sessions across cookie clears using multi-signal browser fingerprinting.

## Architecture

- **Persistence:** SQLite with a multi-tenant schema to enforce strict customer isolation (`schema.sql`).
- **Performance:** Redis caching for sub-millisecond lookups on returning users.
- **Concurrency:** Redis `SET NX` locks to prevent duplicate stitch records during rapid, simultaneous requests.
- **Client SDK:** Aggregates Canvas drawing, WebGL rendering strings, Shader precision floats, OfflineAudioContext output, and hardware specs into a high-entropy SHA-256 footprint.

## Why This Exists
Cart abandonment is a multi-billion dollar problem. The standard approach relies on cookies, but when a user clears their browser data or browses in a new session, standard tracking fails. AnonID solves this pre-login by bridging the gap between hardware footprints and local cookies, allowing you to instantly restore a guest user's cart or personalization profile the moment they return.

## How it Works

1. **First Visit:** The client-side SDK generates a unique UUID cookie and computes a robust hardware footprint.
2. **Returning Visit:** If the cookie is intact, it's a deterministic match (`confidence: high`).
3. **Cookie Clear Event:** If the user returns with a wiped cookie, the SDK computes the same hardware footprint. The backend cross-references this against historical sessions, verifies trust thresholds, and seamlessly stitches the new cookie to the canonical identity (`confidence: medium`).

## Self-Hosting via Docker Compose

You can easily run the entire AnonID engine locally or on your own VPS.

### 1. Clone & Configure
```bash
git clone https://github.com/NaijaB0T/anonid.git
cd anonid
cp .env.example .env
```

### 2. Run with Docker Compose
This will spin up both the Node.js API server and a dedicated Redis instance.
```bash
docker-compose up -d
```

### 3. Usage
Include the lightweight JavaScript SDK on your client application:
```html
<script src="http://localhost:5050/anonid.js" data-key="YOUR_API_KEY" async></script>
```
Listen for the identity resolution event on your client:
```javascript
window.addEventListener('anonid:ready', (e) => {
  const { resolved_id, is_returning } = e.detail;
  if (is_returning) {
    console.log("Welcome back:", resolved_id);
    // restoreCart(resolved_id);
  }
});
```

## Security & Privacy
AnonID operates **without** storing IP addresses, emails, or direct PII. It utilizes a deterministic browser and hardware layer hash.

## Tech Stack
- TypeScript / Node.js (Express)
- `better-sqlite3`
- `ioredis`

## License
MIT
