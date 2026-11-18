import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@widebed/shared';
import { diffDefinitions } from '@widebed/shared';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';
import { SystemService } from '../src/services/system-service.js';

const people: Record<string, { email: string; role: string; department: string | null; status?: string }> = {
  boss: { email: 'boss@widebed.com', role: 'super_admin', department: null },
  ops: { email: 'ops@widebed.com', role: 'department_manager', department: 'Ops' },
  amy: { email: 'amy@widebed.com', role: 'employee', department: 'Ops' },
  gone: { email: 'gone@widebed.com', role: 'employee', department: 'Ops', status: 'disabled' },
};
const verifier: TokenVerifier = {
  async verify(token) {
    const uid = token.replace(/^tok-/, '');
    if (!people[uid]) throw new Error('bad token');
    return { uid, email: people[uid].email, name: uid, emailVerified: false };
  },
};
const as = (uid: string) => ({ Authorization: `Bearer tok-${uid}` });

const sent: { to: string; subject: string; body: string }[] = [];
const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;
const config = loadConfig({
  NODE_ENV: 'test',
  FIREBASE_PROJECT_ID: 'widebed-automation',
  ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  PUBLIC_BASE_URL: 'https://automation.test',
  CORS_ORIGINS: 'https://app.widebed.test',
  RATE_LIMIT_PER_MINUTE: '10000',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
} as any);
const repos = createMemoryRepositories();
const ctx = buildContext(config, repos, verifier, {
  credentialOverrides: {
    fetchJson: async (url, init) => {
      if (url.includes('/token') && init.body?.includes('authorization_code')) {
        return { status: 200, json: { access_token: 'at-1', refresh_token: 'rt-secret-xyz', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken('support@widebed.com') } };
      }
      if (url.includes('/token')) return { status: 200, json: { access_token: 'at-2', expires_in: 3600 } };
      if (url.includes('/messages/send')) {
        const raw = Buffer.from(JSON.parse(init.body!).raw, 'base64url').toString('utf8');
        const [head, b64] = raw.split('\r\n\r\n');
        sent.push({ to: /^To: (.*)$/m.exec(head!)![1]!, subject: /^Subject: (.*)$/m.exec(head!)![1]!, body: Buffer.from(b64!.replace(/\s/g, ''), 'base64').toString('utf8') });
        return { status: 200, json: { id: 'm1' } };
      }
      return { status: 404, json: {} };
    },
  },
});
startProcessing(ctx);
const app = createApp(ctx);

async function waitFor(id: string) {
  for (let i = 0; i < 200; i++) {
    const res = await request(app).get(`/api/executions/${id}`).set(as('boss'));
    if (['success', 'failed', 'cancelled'].includes(res.body.status)) return res.body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('run did not finish');
}
const failing: WorkflowDefinition = {
  schemaVersion: 1,
  nodes: [
    { id: 't', type: 'trigger.manual', name: 'Start', position: { x: 0, y: 0 }, config: {} },
    { id: 'c', type: 'data.code', name: 'Broken step', position: { x: 200, y: 0 }, config: { code: "throw new Error('Room list is empty')" } },
  ],
  connections: [{ id: 't-c', source: 't', sourceHandle: 'main', target: 'c', targetHandle: 'main' }],
};

let googleId = '';
beforeAll(async () => {
  for (const [uid, p] of Object.entries(people)) {
    await repos.users.create({ uid, name: uid.toUpperCase(), email: p.email, role: p.role as any, department: p.department, status: (p.status ?? 'active') as any, createdAt: new Date().toISOString(), lastLoginAt: null });
  }
  const start = await request(app).post('/api/credentials/google/start').set(as('boss')).send({ name: 'Support inbox' });
  await request(app).get('/oauth/google/callback').query({ code: 'x', state: new URL(start.body.url).searchParams.get('state')! });
  googleId = (await repos.credentials.list(10)).find((c) => c.provider === 'google_oauth')!.credentialId;
});

describe('sharing', () => {
  it('lists active people for workflow creators only', async () => {
    const res = await request(app).get('/api/people').set(as('ops'));
    expect(res.status).toBe(200);
    expect(res.body.items.map((p: any) => p.uid)).toEqual(['amy', 'boss', 'ops']);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(['department', 'email', 'name', 'uid']);
    expect((await request(app).get('/api/people').set(as('amy'))).status).toBe(403);
  });

  it('shares a workflow, lets that person run it, and logs who was added', async () => {
    const wf = await request(app).post('/api/workflows').set(as('ops')).send({ name: 'Shared one' });
    const id = wf.body.workflowId;
    expect((await request(app).get(`/api/workflows/${id}`).set(as('amy'))).status).toBe(404);
    expect((await request(app).patch(`/api/workflows/${id}`).set(as('ops')).send({ sharedWith: ['gone'] })).status).toBe(400);
    const res = await request(app).patch(`/api/workflows/${id}`).set(as('ops')).send({ sharedWith: ['amy', 'amy', 'ops'] });
    expect(res.status).toBe(200);
    expect(res.body.sharedWith).toEqual(['amy']);
    const seen = await request(app).get(`/api/workflows/${id}`).set(as('amy'));
    expect(seen.status).toBe(200);
    expect(seen.body.permissions).toMatchObject({ edit: false, run: true });
    const log = await request(app).get('/api/system/audit-logs').set(as('boss'));
    const entry = log.body.items.find((l: any) => l.action === 'workflow.share');
    expect(entry).toMatchObject({ actorName: 'OPS', metadata: { added: ['amy'], removed: [] } });
  });
});

describe('system settings & failure alerts', () => {
  it('is for Super Admins only and checks the input', async () => {
    expect((await request(app).get('/api/system/settings').set(as('ops'))).status).toBe(403);
    const def = await request(app).get('/api/system/settings').set(as('boss'));
    expect(def.body.alerts).toEqual({ enabled: false, emails: [], credentialId: null, cooldownMinutes: 60 });
    const bad = await request(app).put('/api/system/settings').set(as('boss')).send({ alerts: { enabled: true, emails: [], credentialId: null, cooldownMinutes: 60 } });
    expect(bad.status).toBe(400);
    const badEmail = await request(app).put('/api/system/settings').set(as('boss')).send({ alerts: { enabled: true, emails: ['nope'], credentialId: googleId, cooldownMinutes: 60 } });
    expect(badEmail.status).toBe(400);
  });

  it('sends a test email, then one alert per workflow when live runs fail', async () => {
    const ok = await request(app).put('/api/system/settings').set(as('boss')).send({ alerts: { enabled: true, emails: ['ivan@widebed.com'], credentialId: googleId, cooldownMinutes: 60 } });
    expect(ok.status).toBe(200);
    expect((await request(app).post('/api/system/alerts/test').set(as('boss'))).body).toEqual({ ok: true });
    expect(sent.at(-1)).toMatchObject({ to: 'ivan@widebed.com' });
    sent.length = 0;

    const wf = await request(app).post('/api/workflows').set(as('boss')).send({ name: 'Night audit' });
    const id = wf.body.workflowId;
    await request(app).put(`/api/workflows/${id}/draft`).set(as('boss')).send({ definition: failing });
    // Test runs from the editor never send alerts.
    await waitFor((await request(app).post(`/api/workflows/${id}/run`).set(as('boss')).send({ mode: 'draft' })).body.executionId);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(0);

    await request(app).post(`/api/workflows/${id}/publish`).set(as('boss'));
    const live = await waitFor((await request(app).post(`/api/workflows/${id}/run`).set(as('boss')).send({ mode: 'published' })).body.executionId);
    expect(live.status).toBe('failed');
    for (let i = 0; i < 40 && !sent.length; i++) await new Promise((r) => setTimeout(r, 25));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('Room list is empty');
    expect(sent[0]!.body).toContain(`https://app.widebed.test/executions/${live.executionId}`);

    // A second failure within the cooldown stays quiet.
    await waitFor((await request(app).post(`/api/workflows/${id}/run`).set(as('boss')).send({ mode: 'published' })).body.executionId);
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toHaveLength(1);
  });
});

describe('monitoring & backup', () => {
  it('counts runs per day in the viewer’s time zone', () => {
    const now = Date.parse('2026-11-14T10:00:00Z'); // 18:00 in Kuala Lumpur
    const days = SystemService.bucketByDay(
      [
        { createdAt: '2026-11-14T01:00:00Z', status: 'success' },
        { createdAt: '2026-11-13T17:00:00Z', status: 'failed' }, // 01:00 on the 14th in KL
        { createdAt: '2026-11-13T15:00:00Z', status: 'success' }, // 23:00 on the 13th in KL
        { createdAt: '2026-11-13T15:30:00Z', status: 'running' },
        { createdAt: '2026-10-01T00:00:00Z', status: 'success' }, // outside the range
      ],
      3,
      'Asia/Kuala_Lumpur',
      now,
    );
    expect(days).toEqual([
      { date: '2026-11-12', success: 0, failed: 0, other: 0 },
      { date: '2026-11-13', success: 1, failed: 0, other: 1 },
      { date: '2026-11-14', success: 1, failed: 1, other: 0 },
    ]);
  });

  it('returns daily numbers through the API', async () => {
    const res = await request(app).get('/api/dashboard/daily').query({ days: 7, tz: 'Not/AZone' }).set(as('boss'));
    expect(res.status).toBe(200);
    expect(res.body.timeZone).toBe('Asia/Kuala_Lumpur');
    expect(res.body.days).toHaveLength(7);
    const total = res.body.days.reduce((s: number, d: any) => s + d.success + d.failed + d.other, 0);
    expect(total).toBeGreaterThanOrEqual(3);
  });

  it('downloads every workflow in one backup file without secrets', async () => {
    expect((await request(app).get('/api/system/backup').set(as('ops'))).status).toBe(403);
    const res = await request(app).get('/api/system/backup').set(as('boss'));
    expect(res.status).toBe(200);
    expect(res.body.format).toBe('widebed-automation/backup');
    expect(res.body.workflows.length).toBe(2);
    expect(res.body.workflows[0].workflow.definition.nodes.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain('rt-secret-xyz');
  });
});

describe('version compare', () => {
  it('describes added, removed, changed and re-linked steps', () => {
    const older: WorkflowDefinition = {
      ...failing,
      nodes: [...failing.nodes, { id: 'm', type: 'comm.gmailSend', name: 'Email', position: { x: 400, y: 0 }, config: { to: 'a@x.com', subject: 'Hi' } }],
      connections: [...failing.connections, { id: 'c-m', source: 'c', sourceHandle: 'main', target: 'm', targetHandle: 'main' }],
    };
    const newer: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        { ...failing.nodes[0]!, position: { x: 50, y: 50 } },
        { id: 'm', type: 'comm.gmailSend', name: 'Email tenant', position: { x: 400, y: 0 }, config: { to: 'a@x.com', subject: 'Rent due' } },
        { id: 'w', type: 'logic.wait', name: 'Wait', position: { x: 200, y: 0 }, config: {} },
      ],
      connections: [{ id: 't-m', source: 't', sourceHandle: 'main', target: 'm', targetHandle: 'main' }],
    };
    const d = diffDefinitions(older, newer);
    expect(d.added.map((n) => n.name)).toEqual(['Wait']);
    expect(d.removed.map((n) => n.name)).toEqual(['Broken step']);
    expect(d.changed).toEqual([{ id: 'm', name: 'Email tenant', type: 'comm.gmailSend', changes: [{ field: 'Name', before: 'Email', after: 'Email tenant' }, { field: 'subject', before: 'Hi', after: 'Rent due' }] }]);
    expect(d.links).toEqual({ added: ['Start → Email tenant'], removed: ['Start → Broken step', 'Broken step → Email tenant'] });
    expect(d.moved).toBe(1);
    expect(d.same).toBe(false);
    expect(diffDefinitions(older, older).same).toBe(true);
  });
});
