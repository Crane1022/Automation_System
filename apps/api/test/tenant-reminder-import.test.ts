import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildContext } from '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';

/** The PMS Tenant Reminder file imports through Workflows → Import like any export. */

function findFile(rel: string) {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++, dir = path.dirname(dir)) if (fs.existsSync(path.join(dir, rel))) return path.join(dir, rel);
  throw new Error(`${rel} not found`);
}

describe('Tenant Reminder (PMS) import', () => {
  it('imports as a new inactive workflow and asks for the PMS and Gmail connections', async () => {
    const repos = createMemoryRepositories();
    const verifier: TokenVerifier = { verify: async (t) => ({ uid: t.replace('tok-', ''), email: 'it@x.com', name: 'IT', emailVerified: true }) };
    const ctx = buildContext(loadConfig({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: 't', ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), RATE_LIMIT_PER_MINUTE: '100000' } as any), repos, verifier);
    const app = createApp(ctx);
    await repos.users.create({ uid: 'it', name: 'IT', email: 'it@x.com', role: 'it_admin', department: 'IT', status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null } as any);
    const file = JSON.parse(fs.readFileSync(findFile('docs/workflows/Tenant_Reminder_PMS.widebed.json'), 'utf8'));
    const res = await request(app).post('/api/workflows/import').set({ Authorization: 'Bearer tok-it' }).send({ file });
    expect(res.status).toBe(201);
    expect(res.body.workflow.name).toBe('Tenant Reminder (PMS)');
    expect(res.body.report.needsCredential.length).toBe(22); // 7 PMS reads + 5 PMS updates + 10 emails
    expect(res.body.issues.every((i: any) => /connection|Google account/i.test(i.message))).toBe(true);
  });
});
