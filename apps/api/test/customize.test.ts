import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/create-app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';

/** "Customize everything": formulas, JSON editing, Code for editors, reusable custom steps. */

const people: Record<string, { role: string; department: string | null }> = {
  boss: { role: 'super_admin', department: null },
  it: { role: 'it_admin', department: 'IT' },
  ops: { role: 'department_manager', department: 'Ops' },
  emp: { role: 'employee', department: 'Ops' },
  sales: { role: 'department_manager', department: 'Sales' },
};
const verifier: TokenVerifier = { verify: async (t) => ({ uid: t.replace('tok-', ''), email: `${t}@x.com`, name: t, emailVerified: true }) };
const as = (uid: string) => ({ Authorization: `Bearer tok-${uid}` });
const repos = createMemoryRepositories();
const ctx = buildContext(loadConfig({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: 't', ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), RATE_LIMIT_PER_MINUTE: '10000', PUBLIC_BASE_URL: 'https://automation.test' } as any), repos, verifier);
startProcessing(ctx);
const app = createApp(ctx);

beforeAll(async () => {
  for (const [uid, p] of Object.entries(people)) {
    await repos.users.create({ uid, name: uid, email: `${uid}@x.com`, role: p.role as any, department: p.department, status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null });
  }
});

async function waitFor(executionId: string) {
  for (let i = 0; i < 100; i++) {
    const e = await repos.executions.get(executionId);
    if (e && ['success', 'failed', 'cancelled'].includes(e.status)) return e;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('run did not finish');
}
const n = (id: string, type: string, name: string, config: Record<string, unknown> = {}) => ({ id, type, name, position: { x: 0, y: 0 }, config });
const e = (a: string, b: string) => ({ id: `${a}-${b}`, source: a, sourceHandle: 'main', target: b, targetHandle: 'main' });

describe('Formulas: preview from the last run', () => {
  it('works out a formula with the latest run’s data, and explains mistakes', async () => {
    const id = (await request(app).post('/api/workflows').set(as('ops')).send({ name: 'Preview' })).body.workflowId;
    const definition = { schemaVersion: 1, settings: {}, nodes: [n('t', 'trigger.manual', 'Start'), n('l', 'logic.limit', 'Limit', { maxItems: 5 })], connections: [e('t', 'l')] };
    await request(app).put(`/api/workflows/${id}/draft`).set(as('ops')).send({ definition });

    const before = await request(app).post(`/api/workflows/${id}/preview-expression`).set(as('ops')).send({ nodeId: 'l', value: '{{ 1 + 2 }}' });
    expect(before.body).toMatchObject({ ok: true, value: 3, fromRun: false });

    const run = await request(app).post(`/api/workflows/${id}/run`).set(as('ops')).send({ mode: 'draft', payload: { name: 'ana lee', rooms: [{ n: 'A-12' }, { n: 'B-03' }] } });
    await waitFor(run.body.executionId);

    const ok = await request(app).post(`/api/workflows/${id}/preview-expression`).set(as('ops')).send({ nodeId: 'l', value: "Hi {{ $json.name.split(' ')[0].toTitleCase() }} — {{ $('Start').item.json.rooms.map(r => r.n).join(', ') }}" });
    expect(ok.body).toMatchObject({ ok: true, value: 'Hi Ana — A-12, B-03', fromRun: true });
    const bad = await request(app).post(`/api/workflows/${id}/preview-expression`).set(as('ops')).send({ nodeId: 'l', value: '{{ $json.name.shout() }}' });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error).toMatch(/Texts have no \.shout\(\)/);
    // Only people who may edit the workflow can preview.
    expect((await request(app).post(`/api/workflows/${id}/preview-expression`).set(as('sales')).send({ nodeId: 'l', value: '{{ 1 }}' })).status).toBe(404);
  });
});

describe('JSON tab: paste from n8n', () => {
  it('converts a copied n8n node into this app’s settings', async () => {
    const node = { nodes: [{ name: 'Send', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.3, position: [0, 0], parameters: { method: 'POST', url: 'https://api.example.com/x', sendBody: true, bodyParameters: { parameters: [{ name: 'message', value: "={{ $json.output.toUpperCase() }}" }] } } }], connections: {} };
    const r = await request(app).post('/api/workflows/convert-n8n-node').set(as('ops')).send({ node });
    expect(r.status).toBe(200);
    expect(r.body.type).toBe('data.httpRequest');
    expect(r.body.config).toMatchObject({ method: 'POST', url: 'https://api.example.com/x', bodyType: 'fields', bodyFields: [{ key: 'message', value: '{{ $json.output.toUpperCase() }}' }] });
    expect(r.body.warnings.join(' ')).not.toMatch(/JavaScript/);
    const bad = await request(app).post('/api/workflows/convert-n8n-node').set(as('ops')).send({ node: { hello: 1 } });
    expect(bad.status).toBe(400);
    expect((await request(app).post('/api/workflows/convert-n8n-node').set(as('emp')).send({ node })).status).toBe(403);
  });
});

describe('Code steps for workflow builders (Admin setting)', () => {
  const codeDef = (code: string) => ({ schemaVersion: 1, settings: {}, nodes: [n('t', 'trigger.manual', 'Start'), n('c', 'data.code', 'Tidy', { code, timeoutMs: 5000 })], connections: [e('t', 'c')] });

  it('is IT-only by default, and the editor is told so', async () => {
    const id = (await request(app).post('/api/workflows').set(as('ops')).send({ name: 'Code' })).body.workflowId;
    const put = await request(app).put(`/api/workflows/${id}/draft`).set(as('ops')).send({ definition: codeDef('return items;') });
    expect(put.status).toBe(403);
    expect(put.body.error.message ?? put.text).toMatch(/Settings → Code steps/);
    expect((await request(app).get('/api/me').set(as('ops'))).body).toMatchObject({ canWriteCode: false, codeLimits: { memoryMb: 128 } });
    expect((await request(app).get('/api/me').set(as('it'))).body.canWriteCode).toBe(true);
  });

  it('an Admin can open it to everyone who builds workflows (logged), but never to employees', async () => {
    expect((await request(app).put('/api/system/settings').set(as('ops')).send({})).status).toBe(403);
    const current = (await request(app).get('/api/system/settings').set(as('boss'))).body;
    expect(current.code).toEqual({ whoCanWrite: 'it_admin' });
    const saved = await request(app).put('/api/system/settings').set(as('boss')).send({ ...current, code: { whoCanWrite: 'editors' } });
    expect(saved.status).toBe(200);
    expect(saved.body.code.whoCanWrite).toBe('editors');
    expect((await repos.audit.list(50)).items.some((a: any) => a.action === 'settings.code')).toBe(true);

    expect((await request(app).get('/api/me').set(as('ops'))).body.canWriteCode).toBe(true);
    expect((await request(app).get('/api/me').set(as('emp'))).body.canWriteCode).toBe(false);
    const id = (await request(app).post('/api/workflows').set(as('ops')).send({ name: 'Code 2' })).body.workflowId;
    expect((await request(app).put(`/api/workflows/${id}/draft`).set(as('ops')).send({ definition: codeDef('return items.map(i => ({ ...i, ok: true }));') })).status).toBe(200);

    // Saving other settings later keeps the choice.
    const again = await request(app).put('/api/system/settings').set(as('boss')).send({ alerts: current.alerts });
    expect(again.body.code.whoCanWrite).toBe('editors');
  });
});

describe('Reusable team steps', () => {
  const limitStep = { name: 'Last bookings', description: 'Keeps the newest bookings', baseType: 'logic.limit', config: { maxItems: 1, keep: 'last' }, fields: [{ key: 'maxItems', label: 'How many bookings' }] };
  const wfWith = (values: Record<string, unknown>, stepId: string) => ({
    schemaVersion: 1, settings: {},
    nodes: [n('t', 'trigger.manual', 'Start', { testData: JSON.stringify([{ b: 1 }, { b: 2 }, { b: 3 }]) }), n('s', 'util.customStep', 'Last bookings', { stepId, values })],
    connections: [e('t', 's')],
  });

  it('saves a step for the team; the team sees it, other teams do not', async () => {
    const saved = await request(app).post('/api/custom-steps').set(as('ops')).send(limitStep);
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ name: 'Last bookings', department: 'Ops', baseType: 'logic.limit', icon: expect.any(String) });
    const mine = (await request(app).get('/api/custom-steps').set(as('ops'))).body.items;
    expect(mine.map((s: any) => s.name)).toContain('Last bookings');
    expect((await request(app).get('/api/custom-steps').set(as('emp'))).body.items).toHaveLength(1);
    expect((await request(app).get('/api/custom-steps').set(as('sales'))).body.items).toHaveLength(0);
    expect((await request(app).get('/api/custom-steps').set(as('boss'))).body.items).toHaveLength(1);
    // Employees cannot save; only Admins may share with everyone.
    expect((await request(app).post('/api/custom-steps').set(as('emp')).send(limitStep)).status).toBe(403);
    expect((await request(app).post('/api/custom-steps').set(as('ops')).send({ ...limitStep, shareWith: 'everyone' })).status).toBe(403);
  });

  it('refuses steps that cannot be shared or are incomplete', async () => {
    const post = (b: any) => request(app).post('/api/custom-steps').set(as('it')).send({ ...limitStep, ...b });
    expect((await post({ baseType: 'trigger.manual', config: {} })).body.error).toMatch(/Triggers/);
    expect((await post({ baseType: 'data.code', config: { code: 'return items' } })).status).toBe(400);
    expect((await post({ baseType: 'logic.if', config: {} })).status).toBe(400);
    expect((await post({ fields: [{ key: 'nope', label: 'x' }] })).status).toBe(400);
    expect((await post({ config: { maxItems: 'lots' } })).status).toBe(422);
    expect((await post({ baseType: 'data.httpRequest', config: { method: 'GET', url: 'https://x.test', auth: 'cred_missing' }, fields: [] })).status).toBe(403);
  });

  it('runs in a workflow with the team’s values; changes to the saved step reach every workflow', async () => {
    const step = (await request(app).post('/api/custom-steps').set(as('ops')).send({ ...limitStep, name: 'Newest' })).body;
    const id = (await request(app).post('/api/workflows').set(as('ops')).send({ name: 'Uses team step' })).body.workflowId;
    expect((await request(app).put(`/api/workflows/${id}/draft`).set(as('ops')).send({ definition: wfWith({ maxItems: 2, keep: 'first' }, step.stepId) })).status).toBe(200);
    const out = async () => {
      const run = await request(app).post(`/api/workflows/${id}/run`).set(as('ops')).send({ mode: 'draft' });
      const done = await waitFor(run.body.executionId);
      expect(done.status).toBe('success');
      const s = (await repos.executions.listSteps(run.body.executionId)).find((x) => x.nodeId === 's')!;
      return JSON.stringify(s.outputData);
    };
    // maxItems comes from the workflow; "keep" is fixed by the saved step (the workflow cannot change it).
    let o = await out();
    expect(o).toContain('"b":2');
    expect(o).toContain('"b":3');
    expect(o).not.toContain('"b":1');

    expect((await request(app).patch(`/api/custom-steps/${step.stepId}`).set(as('sales')).send({ name: 'x' })).status).toBe(404);
    expect((await request(app).patch(`/api/custom-steps/${step.stepId}`).set(as('emp')).send({ name: 'x' })).status).toBe(403);
    expect((await request(app).patch(`/api/custom-steps/${step.stepId}`).set(as('ops')).send({ config: { maxItems: 1, keep: 'first' } })).status).toBe(200);
    o = await out();
    expect(o).toContain('"b":1');
    expect(o).not.toContain('"b":3');

    // Another team cannot put it in their workflow; once deleted, runs say so.
    const sid = (await request(app).post('/api/workflows').set(as('sales')).send({ name: 'Sales copy' })).body.workflowId;
    const denied = await request(app).put(`/api/workflows/${sid}/draft`).set(as('sales')).send({ definition: wfWith({}, step.stepId) });
    expect(denied.status).toBe(403);
    expect((await request(app).delete(`/api/custom-steps/${step.stepId}`).set(as('ops'))).status).toBe(204);
    const run = await request(app).post(`/api/workflows/${id}/run`).set(as('ops')).send({ mode: 'draft' });
    const done = await waitFor(run.body.executionId);
    expect(done.status).toBe('failed');
    expect(done.errorSummary).toMatch(/saved team step was deleted/);
  });
});
