import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@widebed/shared';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/create-app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';
import type { UserDirectory } from '../src/auth/user-directory.js';

// Fake Firebase: token "tok-<uid>" belongs to a fixed set of users.
const people: Record<string, { email: string; name: string }> = {
  boss: { email: 'boss@widebed.com', name: 'Boss' },
  mgr: { email: 'mgr@widebed.com', name: 'Manager' },
  emp: { email: 'emp@widebed.com', name: 'Employee' },
  other: { email: 'other@widebed.com', name: 'Other' },
  newbie: { email: 'newbie@widebed.com', name: 'Newbie' },
};
const verifier: TokenVerifier = {
  async verify(token) {
    const uid = token.replace(/^tok-/, '');
    if (!people[uid]) throw new Error('bad token');
    return { uid, email: people[uid].email, name: people[uid].name, emailVerified: false }; // like console-created users
  },
};

let target: http.Server;
let base = '';
let slowHits = 0;
beforeAll(async () => {
  target = http.createServer((req, res) => {
    if (req.url === '/slow') {
      slowHits++;
      setTimeout(() => res.end('{}'), 3000);
      return;
    }
    if (req.url === '/fail') {
      res.writeHead(400);
      return res.end('bad');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, ok: true }));
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
});
afterAll(() => target.close());

const config = loadConfig({
  NODE_ENV: 'test',
  FIREBASE_PROJECT_ID: 'test',
  ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  SUPER_ADMIN_EMAILS: 'boss@widebed.com',
  HTTP_ALLOW_PRIVATE_NETWORKS: 'true',
  PUBLIC_BASE_URL: 'https://automation.test',
  RATE_LIMIT_PER_MINUTE: '10000',
} as any);
const repos = createMemoryRepositories();
// Fake Firebase Auth admin: maps emails to the uids above.
const disabledCalls: [string, boolean][] = [];
const directory: UserDirectory = {
  async ensureAccount(email) {
    const uid = Object.keys(people).find((k) => people[k].email === email)!;
    return { uid, existed: false };
  },
  async setDisabled(uid, disabled) {
    disabledCalls.push([uid, disabled]);
  },
};
const ctx = buildContext(config, repos, verifier, { directory });
startProcessing(ctx);
const app = createApp(ctx);
const as = (uid: string) => ({ Authorization: `Bearer tok-${uid}` });

async function waitFor(id: string, uid = 'boss', statuses = ['success', 'failed', 'cancelled']) {
  for (let i = 0; i < 100; i++) {
    const res = await request(app).get(`/api/executions/${id}`).set(as(uid));
    if (statuses.includes(res.body.status)) return res.body;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`execution ${id} did not finish`);
}

function def(url: string): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'trg', type: 'trigger.manual', name: 'Start', position: { x: 0, y: 0 }, config: {} },
      { id: 'req', type: 'data.httpRequest', name: 'Call API', position: { x: 200, y: 0 }, config: { url } },
      { id: 'chk', type: 'logic.if', name: 'OK?', position: { x: 400, y: 0 }, config: { conditions: [{ left: '{{ $json.body.ok }}', operator: 'isTrue' }] } },
    ],
    connections: [
      { id: 'c1', source: 'trg', sourceHandle: 'main', target: 'req', targetHandle: 'main' },
      { id: 'c2', source: 'req', sourceHandle: 'main', target: 'chk', targetHandle: 'main' },
    ],
  };
}

describe('authentication & users', () => {
  it('rejects requests without a valid token', async () => {
    expect((await request(app).get('/api/me')).status).toBe(401);
    expect((await request(app).get('/api/me').set('Authorization', 'Bearer nope')).status).toBe(401);
  });

  it('bootstraps the super admin and keeps other users pending', async () => {
    // The UI fires several requests at once on first sign-in: none may fail.
    const first = await Promise.all([1, 2, 3, 4].map(() => request(app).get('/api/me').set(as('boss'))));
    expect(first.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const me = await request(app).get('/api/me').set(as('boss'));
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('super_admin');
    const pending = await request(app).get('/api/me').set(as('emp'));
    expect(pending.status).toBe(403);
    expect(pending.body.error).toMatch(/approval/);
  });

  it('lets the super admin activate users and assign roles', async () => {
    await request(app).get('/api/me').set(as('mgr'));
    await request(app).get('/api/me').set(as('other'));
    for (const [uid, role, department] of [['emp', 'employee', 'Ops'], ['mgr', 'department_manager', 'Ops'], ['other', 'employee', 'Sales']]) {
      const r = await request(app).patch(`/api/users/${uid}`).set(as('boss')).send({ status: 'active', role, department });
      expect(r.status).toBe(200);
    }
    expect((await request(app).get('/api/me').set(as('emp'))).body.role).toBe('employee');
    expect((await request(app).get('/api/users').set(as('emp'))).status).toBe(403);
    // Cannot demote yourself
    expect((await request(app).patch('/api/users/boss').set(as('boss')).send({ role: 'employee' })).status).toBe(400);
  });
});

describe('inviting users', () => {
  it('lets an admin invite someone who can sign in straight away with the chosen role', async () => {
    const inv = await request(app).post('/api/users/invite').set(as('boss')).send({ email: 'NewBie@widebed.com', name: 'New Bie', role: 'department_manager', department: 'Ops' });
    expect(inv.status).toBe(201);
    expect(inv.body).toMatchObject({ uid: 'newbie', email: 'newbie@widebed.com', role: 'department_manager', status: 'active' });
    const me = await request(app).get('/api/me').set(as('newbie'));
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('department_manager');
    // Inviting the same person twice is refused.
    expect((await request(app).post('/api/users/invite').set(as('boss')).send({ email: 'newbie@widebed.com', name: 'x', role: 'employee' })).status).toBe(409);
  });

  it('only user managers can invite, and disabling also blocks Firebase sign-in', async () => {
    expect((await request(app).post('/api/users/invite').set(as('newbie')).send({ email: 'a@b.com', name: 'A', role: 'employee' })).status).toBe(403);
    await request(app).patch('/api/users/newbie').set(as('boss')).send({ status: 'disabled' });
    expect(disabledCalls).toContainEqual(['newbie', true]);
    expect((await request(app).get('/api/me').set(as('newbie'))).status).toBe(403);
  });
});

describe('workflows, publishing and execution', () => {
  let wfId = '';

  it('creates, saves a draft and validates', async () => {
    const created = await request(app).post('/api/workflows').set(as('boss')).send({ name: 'Booking check', department: 'Ops', tags: ['pms'] });
    expect(created.status).toBe(201);
    wfId = created.body.workflowId;
    const saved = await request(app).put(`/api/workflows/${wfId}/draft`).set(as('boss')).send({ definition: def(`${base}/v1`) });
    expect(saved.status).toBe(200);
    expect(saved.body.issues.filter((i: any) => i.severity === 'error')).toEqual([]);
  });

  it('runs a draft test run with real HTTP results', async () => {
    const run = await request(app).post(`/api/workflows/${wfId}/run`).set(as('boss')).send({ mode: 'draft', payload: { id: 7 } });
    expect(run.status).toBe(202);
    const exec = await waitFor(run.body.executionId);
    expect(exec.status).toBe('success');
    expect(exec.isTestRun).toBe(true);
    expect(exec.steps.map((s: any) => s.status)).toEqual(['success', 'success', 'success']);
    expect(exec.steps[1].outputData.main[0].body.path).toBe('/v1');
    expect(exec.triggerItems).toBeUndefined(); // replay payload never leaves the server
  });

  it('refuses to run a published version before publishing', async () => {
    const r = await request(app).post(`/api/workflows/${wfId}/run`).set(as('boss')).send({ mode: 'published' });
    expect(r.status).toBe(422);
  });

  it('publishes immutable versions: editing the draft does not change the published run', async () => {
    const pub = await request(app).post(`/api/workflows/${wfId}/publish`).set(as('boss'));
    expect(pub.status).toBe(200);
    expect(pub.body.version.versionNumber).toBe(1);
    await request(app).put(`/api/workflows/${wfId}/draft`).set(as('boss')).send({ definition: def(`${base}/v2-draft`) });
    const run = await request(app).post(`/api/workflows/${wfId}/run`).set(as('boss')).send({ mode: 'published' });
    const exec = await waitFor(run.body.executionId);
    expect(exec.workflowVersion).toBe(1);
    expect(exec.steps[1].outputData.main[0].body.path).toBe('/v1');
    const pub2 = await request(app).post(`/api/workflows/${wfId}/publish`).set(as('boss'));
    expect(pub2.body.version.versionNumber).toBe(2);
    const versions = await request(app).get(`/api/workflows/${wfId}/versions`).set(as('boss'));
    expect(versions.body.items.map((v: any) => v.versionNumber)).toEqual([2, 1]);
  });

  it('tests a single node (runs only up to it)', async () => {
    const r = await request(app).post(`/api/workflows/${wfId}/nodes/req/test`).set(as('boss')).send({});
    const exec = await waitFor(r.body.executionId);
    expect(exec.steps.map((s: any) => s.nodeId)).toEqual(['trg', 'req']);
  });

  it('records failures with an error summary and allows a safe retry', async () => {
    const created = await request(app).post('/api/workflows').set(as('boss')).send({ name: 'Failing', department: 'Ops' });
    const id = created.body.workflowId;
    await request(app).put(`/api/workflows/${id}/draft`).set(as('boss')).send({ definition: def(`${base}/fail`) });
    await request(app).post(`/api/workflows/${id}/publish`).set(as('boss'));
    const run = await request(app).post(`/api/workflows/${id}/run`).set(as('boss')).send({ mode: 'published', payload: { x: 1 } });
    const failed = await waitFor(run.body.executionId);
    expect(failed.status).toBe('failed');
    expect(failed.errorSummary).toMatch(/Call API: HTTP 400/);
    const retry = await request(app).post(`/api/executions/${failed.executionId}/retry`).set(as('boss'));
    expect(retry.status).toBe(202);
    const second = await waitFor(retry.body.executionId);
    expect(second.retryOf).toBe(failed.executionId);
    expect(second.triggerType).toBe('retry');
    expect(second.steps[0].outputData.main[0]).toEqual({ x: 1 });
  });

  it('cancels a running execution', async () => {
    const created = await request(app).post('/api/workflows').set(as('boss')).send({ name: 'Slow' });
    const id = created.body.workflowId;
    await request(app).put(`/api/workflows/${id}/draft`).set(as('boss')).send({ definition: def(`${base}/slow`) });
    const run = await request(app).post(`/api/workflows/${id}/run`).set(as('boss')).send({ mode: 'draft' });
    await waitFor(run.body.executionId, 'boss', ['running']);
    await new Promise((r) => setTimeout(r, 100));
    const c = await request(app).post(`/api/executions/${run.body.executionId}/cancel`).set(as('boss'));
    expect(c.status).toBe(200);
    const exec = await waitFor(run.body.executionId);
    expect(exec.status).toBe('cancelled');
  });

  it('streams live events over SSE', async () => {
    const run = await request(app).post(`/api/workflows/${wfId}/run`).set(as('boss')).send({ mode: 'draft' });
    const res = await request(app).get(`/api/executions/${run.body.executionId}/stream`).set(as('boss')).buffer(true).parse((r, cb) => {
      let data = '';
      r.on('data', (c: Buffer) => (data += c.toString()));
      r.on('end', () => cb(null, data));
    });
    const text = res.body as string;
    expect(text).toContain('event: snapshot');
    expect(text).toMatch(/"status":"success"/);
  });

  it('serves dashboard statistics', async () => {
    const s = await request(app).get('/api/dashboard/stats').set(as('boss'));
    expect(s.status).toBe(200);
    expect(s.body.workflows.total).toBeGreaterThanOrEqual(3);
    expect(s.body.executions.total).toBeGreaterThan(0);
    expect(s.body.executions.failed).toBeGreaterThan(0);
    expect(s.body.recent.length).toBeGreaterThan(0);
  });
});

describe('role-based access', () => {
  it('scopes workflows by role and department', async () => {
    const empCreate = await request(app).post('/api/workflows').set(as('emp')).send({ name: 'Nope' });
    expect(empCreate.status).toBe(403);

    const mgrList = await request(app).get('/api/workflows').set(as('mgr'));
    expect(mgrList.body.items.every((w: any) => w.department === 'Ops' || w.ownerId === 'mgr')).toBe(true);
    expect(mgrList.body.items.length).toBeGreaterThan(0);

    const empList = await request(app).get('/api/workflows').set(as('emp'));
    expect(empList.body.items).toEqual([]);

    const someOps = mgrList.body.items[0].workflowId;
    expect((await request(app).get(`/api/workflows/${someOps}`).set(as('other'))).status).toBe(404);

    // Manager creates a workflow: department is forced to their own.
    const mine = await request(app).post('/api/workflows').set(as('mgr')).send({ name: 'Mgr flow', department: 'Sales' });
    expect(mine.body.department).toBe('Ops');

    // Share with an employee: they can view and run the published version but not edit.
    await request(app).patch(`/api/workflows/${someOps}`).set(as('boss')).send({ sharedWith: ['emp'] });
    expect((await request(app).get(`/api/workflows/${someOps}`).set(as('emp'))).status).toBe(200);
    expect((await request(app).put(`/api/workflows/${someOps}/draft`).set(as('emp')).send({ definition: def(base) })).status).toBe(403);
    const empRun = await request(app).post(`/api/workflows/${someOps}/run`).set(as('emp')).send({ mode: 'published' });
    expect(empRun.status).toBe(202);
    await waitFor(empRun.body.executionId, 'emp');
    const empExecs = await request(app).get('/api/executions').set(as('emp'));
    expect(empExecs.body.items.length).toBe(1); // only their own
    expect(empExecs.body.items[0].initiatedBy).toBe('emp');
  });
});

describe('webhooks', () => {
  let url = '';
  let secret = '';
  let token = '';
  let id = '';

  it('issues a webhook URL once on publish', async () => {
    const created = await request(app).post('/api/workflows').set(as('boss')).send({ name: 'Inbound' });
    id = created.body.workflowId;
    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: 'hook', type: 'trigger.webhook', name: 'Hook', position: { x: 0, y: 0 }, config: { method: 'POST', requireSignature: true } },
        { id: 'chk', type: 'logic.if', name: 'VIP?', position: { x: 200, y: 0 }, config: { conditions: [{ left: '{{ $json.body.tier }}', operator: 'equals', right: 'vip' }] } },
      ],
      connections: [{ id: 'c', source: 'hook', sourceHandle: 'main', target: 'chk', targetHandle: 'main' }],
    };
    await request(app).put(`/api/workflows/${id}/draft`).set(as('boss')).send({ definition });
    const pub = await request(app).post(`/api/workflows/${id}/publish`).set(as('boss'));
    expect(pub.body.issuedWebhooks).toHaveLength(1);
    ({ url, signingSecret: secret } = pub.body.issuedWebhooks[0]);
    token = url.split('/hooks/')[1];
    expect(url.startsWith('https://automation.test/hooks/')).toBe(true);
    // Re-publishing keeps the same endpoint (no new token issued).
    const pub2 = await request(app).post(`/api/workflows/${id}/publish`).set(as('boss'));
    expect(pub2.body.issuedWebhooks).toHaveLength(0);
    // Listing never reveals tokens.
    const list = await request(app).get(`/api/workflows/${id}/webhooks`).set(as('boss'));
    expect(JSON.stringify(list.body)).not.toContain(token);
  });

  it('rejects calls while inactive, unsigned or with a bad signature', async () => {
    const body = JSON.stringify({ tier: 'vip' });
    expect((await request(app).post(`/hooks/${token}`).set('content-type', 'application/json').send(body)).status).toBe(404);
    await request(app).post(`/api/workflows/${id}/activate`).set(as('boss'));
    expect((await request(app).post(`/hooks/${token}`).set('content-type', 'application/json').send(body)).status).toBe(401);
    expect((await request(app).post(`/hooks/${token}`).set('content-type', 'application/json').set('x-widebed-signature', 'sha256=00').send(body)).status).toBe(401);
    expect((await request(app).post(`/hooks/not-a-real-token-123456789`).send(body)).status).toBe(404);
    expect((await request(app).get(`/hooks/${token}`)).status).toBe(405);
  });

  it('accepts signed calls and deduplicates with Idempotency-Key', async () => {
    const body = JSON.stringify({ tier: 'vip', guest: 'Ana' });
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    const send = () =>
      request(app).post(`/hooks/${token}`).set('content-type', 'application/json').set('x-widebed-signature', sig).set('idempotency-key', 'booking-42').set('authorization', 'Bearer leak').send(body);
    const a = await send();
    const b = await send();
    expect(a.status).toBe(202);
    expect(b.body.executionId).toBe(a.body.executionId);
    expect(b.body.deduplicated).toBe(true);
    const exec = await waitFor(a.body.executionId);
    expect(exec.status).toBe('success');
    expect(exec.triggerType).toBe('webhook');
    const hookOut = exec.steps[0].outputData.main[0];
    expect(hookOut.body).toEqual({ tier: 'vip', guest: 'Ana' });
    expect(hookOut.headers.authorization).toBeUndefined();
    expect(exec.steps[1].outputData.true).toHaveLength(1);
  });

  it('rotates the URL, invalidating the old one', async () => {
    const rot = await request(app).post(`/api/workflows/${id}/webhooks/hook/rotate`).set(as('boss'));
    expect(rot.status).toBe(200);
    const body = '{}';
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect((await request(app).post(`/hooks/${token}`).set('content-type', 'application/json').set('x-widebed-signature', sig).send(body)).status).toBe(404);
  });
});

describe('audit', () => {
  it('records key actions', async () => {
    const logs = await request(app).get('/api/system/audit-logs').set(as('boss'));
    const actions = logs.body.items.map((l: any) => l.action);
    expect(actions).toContain('workflow.publish');
    expect(actions).toContain('user.update');
    expect((await request(app).get('/api/system/audit-logs').set(as('emp'))).status).toBe(403);
  });
});
