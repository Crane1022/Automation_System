/**
 * DEV/TEST ONLY — never used in production (not under src/, not in the Docker image).
 *
 * Starts the real API with in-memory repositories and a verifier that decodes
 * (but does NOT verify) JWTs, so the real web UI can be driven by a browser
 * test with Firebase's sign-in endpoints stubbed.
 *
 *   npx tsx apps/api/test/e2e-harness.ts
 */
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/create-app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';
import { createFakeFirestore } from './fake-firestore.js';

if (process.env.NODE_ENV === 'production') throw new Error('The e2e harness must never run in production');

const insecureDecodeOnly: TokenVerifier = {
  async verify(token) {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    if (!payload.sub) throw new Error('bad token');
    return { uid: payload.sub, email: payload.email ?? null, name: payload.name ?? null, emailVerified: true };
  },
};

const config = loadConfig({
  NODE_ENV: 'development',
  PORT: process.env.PORT ?? '4000',
  FIREBASE_PROJECT_ID: 'demo-widebed',
  ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  SUPER_ADMIN_EMAILS: 'admin@widebed.test',
  HTTP_ALLOW_PRIVATE_NETWORKS: 'true',
  PUBLIC_BASE_URL: 'http://localhost:4173',
  CORS_ORIGINS: 'http://localhost:4173,http://localhost:5173',
} as NodeJS.ProcessEnv);

// Fake account directory for "Invite user" (no real Firebase here).
const directory = {
  async ensureAccount(email: string) {
    return { uid: `u_${crypto.createHash('sha1').update(email).digest('hex').slice(0, 10)}`, existed: false };
  },
  async setDisabled() {},
};
// Firebase nodes talk to an in-memory fake instead of a real project.
const fake = createFakeFirestore();
const ctx = buildContext(config, createMemoryRepositories(), insecureDecodeOnly, { directory, credentialOverrides: { connectFirestore: () => fake.db } });
startProcessing(ctx);
const app = createApp(ctx);
// A small "external API" for HTTP Request nodes to call during the demo.
app.get('/demo/booking/:id', (req, res) => {
  res.json({ bookingId: req.params.id, guest: 'Ana Lim', status: req.params.id.endsWith('1') ? 'confirmed' : 'pending', nights: 3 });
});
app.listen(config.PORT, () => console.log(`[e2e-harness] API on :${config.PORT}`));
