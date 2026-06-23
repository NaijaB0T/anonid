import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = path.join(__dirname, '../data/anonid.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

const schema = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
db.exec(schema);

console.log('Seeding AnonID Database...');

// 1. Create a customer
const customerId = 'cust_' + uuidv4().replace(/-/g, '');
db.prepare(`
    INSERT INTO customers (id, email, name, plan)
    VALUES (?, ?, ?, ?)
`).run(customerId, 'test@example.com', 'Test Corp', 'startup');

console.log(`Created customer: ${customerId}`);

// 2. Generate a raw API key
const rawKey = 'sk_live_' + crypto.randomBytes(24).toString('hex');
const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
const keyPrefix = rawKey.slice(0, 14); // sk_live_abcdef

const keyId = 'key_' + uuidv4().replace(/-/g, '');

db.prepare(`
    INSERT INTO api_keys (id, customer_id, key_hash, key_prefix, label)
    VALUES (?, ?, ?, ?, ?)
`).run(keyId, customerId, keyHash, keyPrefix, 'Default Key');

console.log(`Created API Key: ${rawKey} (Hash: ${keyHash})`);

// 3. Create a namespace
const nsId = 'ns_' + uuidv4().replace(/-/g, '');
db.prepare(`
    INSERT INTO namespaces (id, api_key_id, customer_id, stitch_enabled, stitch_min_sessions, stitch_confidence_mode, session_ttl_days, id_prefix)
    VALUES (?, ?, ?, 1, 2, 'medium', 180, 'usr_')
`).run(nsId, keyId, customerId);

console.log(`Created Namespace: ${nsId}`);

console.log('\n--- Test Config ---');
console.log(`API Key: ${rawKey}`);
console.log('Use this key to test the /v1/identify endpoint.');
