import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowDefinition, WorkflowNode } from '@widebed/shared';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/create-app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';
import { nextRun, type InProcessScheduler } from '../src/services/scheduler.js';
import { scheduleTriggerSchema } from '@widebed/nodes';
import { createFakeFirestore } from './fake-firestore.js';

const people: Record<string, { email: string; role: string; department: string | null }> = {
  boss: { email: 'boss@widebed.com', role: 'super_admin', department: null },
  it: { email: 'it@widebed.com', role: 'it_admin', department: 'IT' },
  ops: { email: 'ops@widebed.com', role: 'department_manager', department: 'Ops' },
  sales: { email: 'sales@widebed.com', role: 'department_manager', department: 'Sales' },
};
const verifier: TokenVerifier = {
  async verify(token) {
    const uid = token.replace(/^tok-/, '');
    if (!people[uid]) throw new Error('bad token');
    return { uid, email: people[uid].email, name: uid, emailVerified: false };
  },
};
const as = (uid: string) => ({ Authorization: `Bearer tok-${uid}` });

const fake = createFakeFirestore();
const googleCalls: any[] = [];
const config = loadConfig({
  NODE_ENV: 'test',
  FIREBASE_PROJECT_ID: 'widebed-automation',
  ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  HTTP_ALLOW_PRIVATE_NETWORKS: 'true',
  PUBLIC_BASE_URL: 'https://automation.test',
  RATE_LIMIT_PER_MINUTE: '10000',
  WAIT_MAX_MS: '5000',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
} as any);
const repos = createMemoryRepositories();
const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;
let googleEmail = 'support@widebed.com';
let googleScope = 'openid email https://www.googleapis.com/auth/gmail.send';
const ctx = buildContext(config, repos, verifier, {
  credentialOverrides: {
    connectFirestore: () => fake.db,
    fetchJson: async (url, init) => {
      googleCalls.push({ url, body: init.body });
      if (url.includes('/token') && init.body?.includes('authorization_code')) {
        return { status: 200, json: { access_token: 'at-1', refresh_token: 'rt-secret', expires_in: 3600, scope: googleScope, id_token: idToken(googleEmail) } };
      }
      if (url.includes('/token')) return { status: 200, json: { access_token: 'at-2', expires_in: 3600 } };
      if (url.includes('/profile')) return { status: 200, json: { emailAddress: 'support@widebed.com' } };
      return { status: 404, json: {} };
    },
  },
});
startProcessing(ctx);
const app = createApp(ctx);
const scheduler = ctx.scheduler as InProcessScheduler;

const SA = JSON.stringify({ type: 'service_account', project_id: 'widebed-pms', client_email: 'x@widebed-pms.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' });

async function waitFor(id: string, statuses = ['success', 'failed', 'cancelled']) {
  for (let i = 0; i < 200; i++) {
    const res = await request(app).get(`/api/executions/${id}`).set(as('boss'));
    if (statuses.includes(res.body.status)) return res.body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`execution ${id} did not reach ${statuses}`);
}
const n = (id: string, type: string, config: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, type, name: id, position: { x: 0, y: 0 }, config, ...extra });
const e = (source: string, target: string, sourceHandle = 'main') => ({ id: `${source}-${target}`, source, sourceHandle, target, targetHandle: 'main' });
async function workflow(uid: string, def: WorkflowDefinition, name = 'wf', department?: string) {
  const created = await request(app).post('/api/workflows').set(as(uid)).send({ name, department });
  const id = created.body.workflowId;
  const saved = await request(app).put(`/api/workflows/${id}/draft`).set(as(uid)).send({ definition: def });
  return { id, saved };
}

beforeAll(async () => {
  for (const [uid, p] of Object.entries(people)) {
    await repos.users.create({ uid, name: uid, email: p.email, role: p.role as any, department: p.department, status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null });
  }
});

describe('credentials', () => {
  let fbId = '';
  let roId = '';

  it('stores a Firebase connection encrypted and never returns the key', async () => {
    const bad = await request(app).post('/api/credentials/firebase').set(as('it')).send({ name: 'PMS', serviceAccountJson: '{"type":"x"}', allowedCollections: ['bookings'] });
    expect(bad.status).toBe(400);
    const res = await request(app).post('/api/credentials/firebase').set(as('it')).send({ name: 'PMS', department: 'Ops', serviceAccountJson: SA, allowedCollections: ['bookings', 'tenants/*/payments'] });
    expect(res.status).toBe(201);
    fbId = res.body.credentialId;
    expect(res.body.details).toMatchObject({ projectId: 'widebed-pms', allowedCollections: ['bookings', 'tenants/*/payments'] });
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE KEY');
    const stored = await repos.credentialSecrets.get(fbId);
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain('PRIVATE KEY');
    const ro = await request(app).post('/api/credentials/firebase').set(as('it')).send({ name: 'PMS read-only', serviceAccountJson: SA, allowedCollections: ['bookings'], readOnly: true });
    roId = ro.body.credentialId;
  });

  it('only lets credential managers create, and hides other departments’ connections', async () => {
    expect((await request(app).post('/api/credentials/event-source').set(as('ops')).send({ name: 'x' })).status).toBe(403);
    const sales = await request(app).get('/api/credentials').set(as('sales'));
    expect(sales.body.items.map((c: any) => c.credentialId)).not.toContain(fbId); // Ops-only
    expect(sales.body.items.map((c: any) => c.credentialId)).toContain(roId); // everyone
    expect(sales.body.google.configured).toBe(true);
  });

  it('refuses the platform’s own collections on its own project', async () => {
    const own = SA.replace('widebed-pms', 'widebed-automation');
    const res = await request(app).post('/api/credentials/firebase').set(as('it')).send({ name: 'self', serviceAccountJson: own, allowedCollections: ['credentials'] });
    expect(res.status).toBe(400);
  });

  it('runs Firebase nodes only inside the allowed collections', async () => {
    const def: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        n('t', 'trigger.manual', { testData: '{"id":"B-1","nights":3}' }),
        n('c', 'data.firebaseCreate', { collection: 'bookings', docId: '{{ $json.id }}', data: '{"nights": {{ $json.nights }}, "status": "new"}' }, { credentialId: fbId }),
        n('u', 'data.firebaseUpdate', { collection: 'bookings', docId: '{{ $json.id }}', data: '{"status":"confirmed"}' }, { credentialId: fbId }),
        n('r', 'data.firebaseRead', { mode: 'query', collection: 'bookings', where: [{ field: 'status', op: '==', value: 'confirmed' }] }, { credentialId: fbId }),
      ],
      connections: [e('t', 'c'), e('c', 'u'), e('u', 'r')],
    };
    const { id, saved } = await workflow('ops', def, 'fb', 'Ops');
    expect(saved.status).toBe(200);
    const run = await request(app).post(`/api/workflows/${id}/run`).set(as('ops')).send({ mode: 'draft' });
    const exec = await waitFor(run.body.executionId);
    expect(exec.status).toBe('success');
    expect(fake.docs.get('bookings/B-1')).toEqual({ nights: 3, status: 'confirmed' });
    expect(exec.steps[3].outputData.main[0]).toMatchObject({ id: 'B-1', status: 'confirmed' });

    // Not in the allow-list:
    def.nodes[1].config.collection = 'staff';
    await request(app).put(`/api/workflows/${id}/draft`).set(as('ops')).send({ definition: def });
    const run2 = await request(app).post(`/api/workflows/${id}/run`).set(as('ops')).send({ mode: 'draft' });
    const exec2 = await waitFor(run2.body.executionId);
    expect(exec2.status).toBe('failed');
    expect(exec2.steps[1].error.code).toBe('COLLECTION_FORBIDDEN');
  });

  it('blocks writes on read-only connections and use by other departments', async () => {
    const def: WorkflowDefinition = { schemaVersion: 1, nodes: [n('t', 'trigger.manual'), n('d', 'data.firebaseDelete', { collection: 'bookings', docId: 'B-1' }, { credentialId: roId })], connections: [e('t', 'd')] };
    const { id } = await workflow('boss', def, 'ro');
    const exec = await waitFor((await request(app).post(`/api/workflows/${id}/run`).set(as('boss')).send({ mode: 'draft' })).body.executionId);
    expect(exec.steps[1].error.code).toBe('READ_ONLY');
    expect(fake.docs.has('bookings/B-1')).toBe(true);

    // Sales manager cannot save a workflow that uses the Ops-only connection.
    const salesDef: WorkflowDefinition = { schemaVersion: 1, nodes: [n('t', 'trigger.manual'), n('r', 'data.firebaseRead', { mode: 'get', collection: 'bookings', docId: 'B-1' }, { credentialId: fbId })], connections: [e('t', 'r')] };
    const { saved } = await workflow('sales', salesDef, 'sales');
    expect(saved.status).toBe(403);
  });

  it('tests a connection and records the result', async () => {
    const t = await request(app).post(`/api/credentials/${fbId}/test`).set(as('it'));
    expect(t.body.ok).toBe(true);
    const list = await request(app).get('/api/credentials').set(as('it'));
    expect(list.body.items.find((c: any) => c.credentialId === fbId).lastTestResult).toMatch(/widebed-pms/);
  });
});

describe('Google OAuth (Gmail)', () => {
  it('connects an account through a signed state and stores only the encrypted refresh token', async () => {
    const start = await request(app).post('/api/credentials/google/start').set(as('it')).send({ name: 'Support inbox' });
    const url = new URL(start.body.url);
    expect(url.searchParams.get('redirect_uri')).toBe('https://automation.test/oauth/google/callback');
    const state = url.searchParams.get('state')!;

    const tampered = await request(app).get('/oauth/google/callback').query({ code: 'c', state: state.slice(0, -2) + 'xx' });
    expect(tampered.headers.location).toMatch(/error=/);

    const ok = await request(app).get('/oauth/google/callback').query({ code: 'auth-code', state });
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe('/credentials?connected=Support%20inbox');
    const cred = (await repos.credentials.list(50)).find((c) => c.provider === 'google_oauth')!;
    expect(cred.details.accountEmail).toBe('support@widebed.com');
    expect(await repos.credentialSecrets.get(cred.credentialId)).not.toContain('rt-secret');

    const test = await request(app).post(`/api/credentials/${cred.credentialId}/test`).set(as('it'));
    expect(test.body).toEqual({ ok: true, message: 'Connected as support@widebed.com' });
    expect(googleCalls.some((c) => c.body?.includes('refresh_token=rt-secret'))).toBe(true);
  });

  it('asks for Google Sheets access and can reconnect an existing connection in place', async () => {
    const cred = (await repos.credentials.list(50)).find((c) => c.provider === 'google_oauth')!;
    const fresh = await request(app).post('/api/credentials/google/start').set(as('it')).send({ name: 'x' });
    expect(new URL(fresh.body.url).searchParams.get('scope')).toContain('https://www.googleapis.com/auth/spreadsheets');

    // Signing in with a different account than the connection is refused.
    googleEmail = 'someone@gmail.com';
    let start = await request(app).post('/api/credentials/google/start').set(as('it')).send({ name: 'ignored', reconnectId: cred.credentialId });
    let back = await request(app).get('/oauth/google/callback').query({ code: 'c2', state: new URL(start.body.url).searchParams.get('state')! });
    expect(decodeURIComponent(back.headers.location)).toMatch(/this connection is for support@widebed.com/);

    // Same account: same credential id, new permissions.
    googleEmail = 'support@widebed.com';
    googleScope = 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/spreadsheets';
    start = await request(app).post('/api/credentials/google/start').set(as('it')).send({ name: 'ignored', reconnectId: cred.credentialId });
    back = await request(app).get('/oauth/google/callback').query({ code: 'c3', state: new URL(start.body.url).searchParams.get('state')! });
    expect(back.headers.location).toBe('/credentials?connected=Support%20inbox');
    const all = (await repos.credentials.list(50)).filter((c) => c.provider === 'google_oauth');
    expect(all).toHaveLength(1);
    expect(all[0]!.credentialId).toBe(cred.credentialId);
    expect(all[0]!.details.scopes).toContain('https://www.googleapis.com/auth/spreadsheets');

    // Only people who manage credentials can reconnect.
    expect((await request(app).post('/api/credentials/google/start').set(as('ops')).send({ name: 'x', reconnectId: cred.credentialId })).status).toBe(403);
  });
});

describe('Code node permissions and sandbox', () => {
  const codeDef = (code: string): WorkflowDefinition => ({
    schemaVersion: 1,
    nodes: [n('t', 'trigger.manual', { testData: '[{"n":1},{"n":2}]' }), n('c', 'data.code', { code })],
    connections: [e('t', 'c')],
  });

  it('only IT admins can add or change code; others can still edit the rest', async () => {
    const { saved } = await workflow('ops', codeDef('return items'), 'code-ops', 'Ops');
    expect(saved.status).toBe(403);
    const { id, saved: ok } = await workflow('it', codeDef('return items.map(i => ({ double: i.n * 2 }))'), 'code-it', 'Ops');
    expect(ok.status).toBe(200);
    // The Ops manager may move nodes / add others without touching the code.
    const wf = await request(app).get(`/api/workflows/${id}`).set(as('ops'));
    const def = wf.body.draftDefinition;
    def.nodes[0].position = { x: 50, y: 50 };
    expect((await request(app).put(`/api/workflows/${id}/draft`).set(as('ops')).send({ definition: def })).status).toBe(200);
    def.nodes[1].config.code = 'return []';
    expect((await request(app).put(`/api/workflows/${id}/draft`).set(as('ops')).send({ definition: def })).status).toBe(403);

    const exec = await waitFor((await request(app).post(`/api/workflows/${id}/run`).set(as('it')).send({ mode: 'draft' })).body.executionId);
    expect(exec.status).toBe('success');
    expect(exec.steps[1].outputData.main).toEqual([{ double: 2 }, { double: 4 }]);
  });

  it('reports sandbox escapes and runaway code as node errors', async () => {
    const { id } = await workflow('it', codeDef('return [{ p: this.constructor.constructor("return process")() }]'), 'escape');
    const exec = await waitFor((await request(app).post(`/api/workflows/${id}/run`).set(as('it')).send({ mode: 'draft' })).body.executionId);
    expect(exec.status).toBe('failed');
    expect(exec.errorSummary).toMatch(/Code generation from strings disallowed/);
  });
});

describe('Wait node', () => {
  it('shows "waiting" during the pause and enforces the maximum', async () => {
    const def: WorkflowDefinition = { schemaVersion: 1, nodes: [n('t', 'trigger.manual'), n('w', 'logic.wait', { amount: 0.4, unit: 'seconds' })], connections: [e('t', 'w')] };
    const { id } = await workflow('boss', def, 'wait');
    const run = await request(app).post(`/api/workflows/${id}/run`).set(as('boss')).send({ mode: 'draft' });
    await waitFor(run.body.executionId, ['waiting']);
    expect((await waitFor(run.body.executionId)).status).toBe('success');

    def.nodes[1].config = { amount: 1, unit: 'hours' };
    await request(app).put(`/api/workflows/${id}/draft`).set(as('boss')).send({ definition: def });
    const long = await waitFor((await request(app).post(`/api/workflows/${id}/run`).set(as('boss')).send({ mode: 'draft' })).body.executionId);
    expect(long.steps[1].error.code).toBe('WAIT_TOO_LONG');
  });

  it('can be cancelled while waiting', async () => {
    const def: WorkflowDefinition = { schemaVersion: 1, nodes: [n('t', 'trigger.manual'), n('w', 'logic.wait', { amount: 4, unit: 'seconds' })], connections: [e('t', 'w')] };
    const { id } = await workflow('boss', def, 'wait-cancel');
    const run = await request(app).post(`/api/workflows/${id}/run`).set(as('boss')).send({ mode: 'draft' });
    await waitFor(run.body.executionId, ['waiting']);
    await request(app).post(`/api/executions/${run.body.executionId}/cancel`).set(as('boss'));
    expect((await waitFor(run.body.executionId)).status).toBe('cancelled');
  });
});

describe('Schedule Trigger', () => {
  it('registers schedules only while active and starts one run per occurrence', async () => {
    const def: WorkflowDefinition = { schemaVersion: 1, nodes: [n('s', 'trigger.schedule', { mode: 'cron', cron: '0 9 * * *', timezone: 'Asia/Kuala_Lumpur' })], connections: [] };
    const { id } = await workflow('boss', def, 'daily');
    await request(app).post(`/api/workflows/${id}/publish`).set(as('boss'));
    expect(scheduler.armed()).not.toContain(`${id}:s`);
    await request(app).post(`/api/workflows/${id}/activate`).set(as('boss'));
    expect(scheduler.armed()).toContain(`${id}:s`);

    await ctx.executions.fireSchedule(id, 's', '2026-11-14T01:00:00.000Z', 'sched:s:1');
    await ctx.executions.fireSchedule(id, 's', '2026-11-14T01:00:00.000Z', 'sched:s:1'); // duplicate occurrence
    const list = await request(app).get('/api/executions').query({ workflowId: id }).set(as('boss'));
    expect(list.body.items).toHaveLength(1);
    const exec = await waitFor(list.body.items[0].executionId);
    expect(exec.triggerType).toBe('schedule');
    expect(exec.steps[0].outputData.main[0]).toEqual({ scheduledFor: '2026-11-14T01:00:00.000Z', timezone: 'Asia/Kuala_Lumpur' });

    await request(app).post(`/api/workflows/${id}/deactivate`).set(as('boss'));
    expect(scheduler.armed()).not.toContain(`${id}:s`);
  });

  it('computes next runs for the simple modes in the chosen time zone', () => {
    const cfg = (c: Record<string, unknown>) => scheduleTriggerSchema.parse({ timezone: 'Asia/Kuala_Lumpur', ...c });
    const from = Date.parse('2026-11-14T05:00:00Z'); // Sat 14 Nov 2026, 1:00 PM in Kuala Lumpur
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    expect(iso(nextRun(cfg({ mode: 'once', date: '2026-11-14', time: '14:00' }), from))).toBe('2026-11-14T06:00:00.000Z');
    expect(iso(nextRun(cfg({ mode: 'once', date: '2026-11-14', time: '12:00' }), from))).toBeNull(); // already passed
    expect(iso(nextRun(cfg({ mode: 'once', date: '2027-01-01', time: '00:00' }), from))).toBe('2026-12-31T16:00:00.000Z');
    expect(iso(nextRun(cfg({ mode: 'daily', time: '09:00' }), from))).toBe('2026-11-15T01:00:00.000Z');
    expect(iso(nextRun(cfg({ mode: 'weekly', weekdays: ['1'], time: '09:00' }), from))).toBe('2026-11-16T01:00:00.000Z'); // Monday
    expect(iso(nextRun(cfg({ mode: 'monthly', dayOfMonth: 'L', time: '18:00' }), from))).toBe('2026-11-30T10:00:00.000Z');
  });

  it('runs a one-time schedule once and then stops', async () => {
    const at = new Date(Date.now() + 60 * 60_000);
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((x) => [x.type, x.value]));
    const future = { mode: 'once', date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, timezone: 'Asia/Kuala_Lumpur' };
    const def: WorkflowDefinition = { schemaVersion: 1, nodes: [n('s', 'trigger.schedule', future)], connections: [] };
    const { id } = await workflow('boss', def, 'once');
    await request(app).post(`/api/workflows/${id}/publish`).set(as('boss'));
    await request(app).post(`/api/workflows/${id}/activate`).set(as('boss'));
    expect(scheduler.armed()).toContain(`${id}:s`);
    const list = await request(app).get('/api/schedules').set(as('boss'));
    const row = list.body.items.find((r: any) => r.workflowId === id);
    expect(row.description).toMatch(/^Once, on /);
    expect(row.nextRunAt).not.toBeNull();

    // A one-time schedule whose time has passed is not armed and shows as finished.
    const past = { ...future, date: '2020-01-01' };
    const old = await workflow('boss', { schemaVersion: 1, nodes: [n('s', 'trigger.schedule', past)], connections: [] }, 'once-past');
    await request(app).post(`/api/workflows/${old.id}/publish`).set(as('boss'));
    await request(app).post(`/api/workflows/${old.id}/activate`).set(as('boss'));
    expect(scheduler.armed()).not.toContain(`${old.id}:s`);
    const list2 = await request(app).get('/api/schedules').set(as('boss'));
    expect(list2.body.items.find((r: any) => r.workflowId === old.id).nextRunAt).toBeNull();
  });
});

describe('HTTP Event Trigger', () => {
  it('starts every active workflow listening to the event, with a valid source key only', async () => {
    const src = await request(app).post('/api/credentials/event-source').set(as('it')).send({ name: 'PMS' });
    expect(src.body.key).toMatch(/^wbe_/);
    const key = src.body.key;

    const def: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [n('ev', 'trigger.event', { eventName: 'booking.created' }), n('f', 'logic.filter', { conditions: [{ left: '{{ $json.data.nights }}', operator: 'greaterThan', right: 1 }] })],
      connections: [e('ev', 'f')],
    };
    const a = await workflow('boss', def, 'listener A');
    const b = await workflow('boss', def, 'listener B (inactive)');
    for (const w of [a, b]) await request(app).post(`/api/workflows/${w.id}/publish`).set(as('boss'));
    await request(app).post(`/api/workflows/${a.id}/activate`).set(as('boss'));

    expect((await request(app).post('/events/booking.created').send({})).status).toBe(401);
    expect((await request(app).post('/events/booking.created').set('Authorization', 'Bearer wbe_wrongwrongwrongwrongwrong').send({})).status).toBe(401);

    const send = () => request(app).post('/events/booking.created').set('Authorization', `Bearer ${key}`).set('Idempotency-Key', 'B-77').send({ bookingId: 'B-77', nights: 3 });
    const res = await send();
    expect(res.status).toBe(202);
    expect(res.body.started).toHaveLength(1);
    expect(res.body.started[0].workflowId).toBe(a.id);
    expect((await send()).body.started[0].deduplicated).toBe(true);

    const exec = await waitFor(res.body.started[0].executionId);
    expect(exec.triggerType).toBe('http_event');
    expect(exec.steps[0].outputData.main[0]).toMatchObject({ event: 'booking.created', source: 'PMS', data: { bookingId: 'B-77', nights: 3 } });

    // Rotating the key invalidates the old one.
    await request(app).post(`/api/credentials/${src.body.credential.credentialId}/rotate`).set(as('it'));
    expect((await send()).status).toBe(401);
  });
});
