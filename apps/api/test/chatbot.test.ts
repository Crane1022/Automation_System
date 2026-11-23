import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDefaultRegistry, searchRows, type AiRequest, type NodeServices } from '@widebed/nodes';
import { runWorkflow, validateWorkflow } from '@widebed/engine';
import type { WorkflowDefinition } from '@widebed/shared';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/create-app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';
import { convertN8n, convertValue } from '../src/services/workflow-transfer.js';
import { chatMemoryFor } from '../src/services/execution-service.js';
import willow from './fixtures/willow-n8n.json';
import { BUILT_IN_TEMPLATES } from '@widebed/shared';

/**
 * The "Willow 4.0" n8n chatbot (GoHighLevel live chat → Gemini agent with memory and
 * Google Sheets tools → reply to GoHighLevel) must import completely and run.
 */

const registry = createDefaultRegistry();
const SHEET_ID = 'SHEET123456789012345678';

/* ------------------------------------------------------------------ fakes */

/** Google Sheets + GoHighLevel, answered from memory. */
function fakeWeb() {
  const tabs: Record<string, unknown[][]> = {
    'System Prompt': [['System Prompt:'], ['You are Willow, the Widebed guest assistant.'], ['(second row, must not cause a second answer)']],
    'Booking Details': [
      ['Booking No', 'Guest', 'Phone', 'Unit Number', 'Check-in'],
      ['WB-1029', 'Ana Lee', '+60 12-345 6789', 'A-12-3', '2026-11-21'],
      ['WB-1030', 'Ben Tan', '60198887777', 'B-01-2', '2026-11-25'],
    ],
    'Property Units': [['Unit Number', 'Parking'], ['A-12-3', 'Level 3, bay 12']],
  };
  const ghl: { headers: Record<string, string>; body: any }[] = [];
  const sheetReads: string[] = [];
  const res = (status: number, body: unknown) => ({ status, statusText: '', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), url: '' });
  const http = {
    async request(req: { method: string; url: string; body?: string; headers?: Record<string, string> }) {
      const u = new URL(req.url);
      if (u.hostname === 'sheets.googleapis.com') {
        expect(req.headers?.authorization).toBe('Bearer g-token');
        const path = decodeURIComponent(u.pathname.replace('/v4/spreadsheets/', ''));
        const [id, rest = ''] = path.split(/\/(.*)/s);
        if (id !== SHEET_ID) return res(404, { error: { message: 'not found' } });
        if (!rest) return res(200, { sheets: Object.keys(tabs).map((title) => ({ properties: { title } })) });
        const title = /^values\/'((?:[^']|'')*)'/.exec(rest)?.[1]?.replace(/''/g, "'") ?? '';
        sheetReads.push(title);
        const grid = tabs[title];
        return grid ? res(200, { range: `'${title}'!A1:Z${grid.length}`, values: grid }) : res(400, { error: { message: `Unable to parse range: ${title}` } });
      }
      if (u.hostname === 'services.leadconnectorhq.com') {
        ghl.push({ headers: req.headers ?? {}, body: JSON.parse(req.body ?? '{}') });
        return res(201, { messageId: 'm1' });
      }
      throw new Error(`unexpected request to ${req.url}`);
    },
  };
  return { http, ghl, sheetReads };
}

/** An AI that follows a script and records what it was asked. */
function fakeAi(answers: string[]) {
  const calls: AiRequest[] = [];
  return {
    calls,
    ai: async (_id: string, req: AiRequest) => {
      calls.push(req);
      return { text: answers.shift() ?? '{"reply":"(no more answers)"}', model: 'fake' };
    },
  };
}

const webhookBody = (text: string, contact = 'contact-ana') => ({ body: { full_name: 'Ana Lee', phone: '+60123456789', customData: { id: contact }, message: { body: text } }, headers: {}, query: {}, method: 'POST' });

/** The imported Willow workflow, with connections chosen like a user would. */
function willowDefinition(): WorkflowDefinition {
  const def = structuredClone(convertN8n(structuredClone(willow)).definition);
  for (const n of def.nodes) {
    if (n.type === 'comm.sheetsRead') n.credentialId = 'cred_google';
    if (n.type === 'ai.chatbot') {
      n.credentialId = 'cred_gemini';
      n.config.googleConnection = 'cred_google';
    }
    if (n.type === 'data.httpRequest') n.config.auth = 'cred_ghl';
  }
  return def;
}

/* ------------------------------------------------------------------ import */

describe('Importing the Willow n8n chatbot', () => {
  const result = convertN8n(structuredClone(willow));

  it('converts every node: nothing is left as “Needs replacing”', () => {
    expect(result.report.unsupported).toEqual([]);
    const types = Object.fromEntries(result.definition.nodes.map((n) => [n.name, n.type]));
    expect(types).toEqual({
      Webhook: 'trigger.webhook',
      'System Prompt': 'comm.sheetsRead',
      Limit: 'logic.limit',
      'Talk to Your Data1': 'ai.chatbot',
      'Reply to GHL': 'data.httpRequest',
    });
    // Model, memory and the 5 sheet tools became part of the chatbot step.
    expect(result.report.converted.filter((c) => c.to === 'part of “Talk to Your Data1”').map((c) => c.name).sort()).toEqual(
      ['Booking Details', 'Customer Service Team', 'FAQ ', 'Google Gemini Chat Model', 'Maintenance Data', 'Memory', 'Property Units Info'].sort(),
    );
    expect(result.report.needsCredential.sort()).toEqual(['Reply to GHL', 'System Prompt', 'Talk to Your Data1']);
    expect(result.definition.connections.map((c) => `${c.source}>${c.target}`)).toHaveLength(4);
  });

  it('keeps the prompt, memory key, look-ups and the GoHighLevel reply', () => {
    const bot = result.definition.nodes.find((n) => n.type === 'ai.chatbot')!;
    expect(bot.config.message).toBe('{{ $node["Webhook"].json.body.message.body }}');
    expect(bot.config.instructions).toContain(`{{ $node["System Prompt"].json['System Prompt:'] }}`);
    expect(bot.config.instructions).toContain("Today's Date: {{ $today }}");
    expect(bot.config.conversationId).toBe('{{ $node["Webhook"].json.body.customData.id }}');
    expect(bot.config.memoryMessages).toBe(40);
    const lookups = bot.config.lookups as any[];
    expect(lookups.map((l) => [l.name, l.sheet])).toEqual([
      ['Booking Details', 'Booking Details'],
      ['Property Units Info', 'Property Units'],
      ['Customer Service Team', 'Customer Service Team'],
      ['FAQ', 'FAQ (Coming Soon)'],
      ['Maintenance Data', 'Maintenance Data'],
    ]);
    expect(lookups[1].description).toMatch(/ONLY use this tool if the guest has already been verified/);
    expect(lookups[0].spreadsheet).toContain(SHEET_ID);

    const reply = result.definition.nodes.find((n) => n.name === 'Reply to GHL')!;
    expect(reply.config).toMatchObject({ method: 'POST', bodyType: 'fields', url: 'https://services.leadconnectorhq.com/conversations/messages' });
    expect(reply.config.bodyFields).toEqual([
      { key: 'type', value: 'Live_Chat' },
      { key: 'contactId', value: '{{ $node["Webhook"].json.body.customData.id }}' },
      { key: 'message', value: '{{ $json.output }}' },
    ]);
    expect(result.report.warnings.join('\n')).toMatch(/API key \/ token.*services\.leadconnectorhq\.com/);
    // One item from a webhook: no noisy "first item" warnings.
    expect(result.report.warnings.join('\n')).not.toMatch(/FIRST item/);
  });

  it('is valid once the connections are chosen', () => {
    expect(validateWorkflow(willowDefinition(), registry)).toEqual([]);
  });

  it('converts $now.format("yyyy-MM-dd") to $today', () => {
    const w: string[] = [];
    expect(convertValue("=Date: {{ $now.format('yyyy-MM-dd') }}", (m) => w.push(m), 'x')).toBe('Date: {{ $today }}');
    expect(w).toEqual([]);
  });
});

/* ------------------------------------------------------------------ running */

describe('Running the imported chatbot', () => {
  const repos = createMemoryRepositories();
  const web = fakeWeb();
  const services = (ai: ReturnType<typeof fakeAi>, workflowId = 'wf_willow'): NodeServices => ({
    http: web.http as any,
    googleToken: async (id) => {
      expect(id).toBe('cred_google');
      return { accessToken: 'g-token', email: 'support@widebed.com', scopes: ['https://www.googleapis.com/auth/spreadsheets'] };
    },
    ai: ai.ai,
    apiKey: async (id) => {
      expect(id).toBe('cred_ghl');
      return { name: 'GoHighLevel', headerName: 'Authorization', value: 'Bearer pit-secret', allowedDomains: ['services.leadconnectorhq.com'] };
    },
    chatMemory: chatMemoryFor(repos, workflowId),
  });
  const run = (def: WorkflowDefinition, body: unknown, svc: NodeServices, workflowId = 'wf_willow') =>
    runWorkflow({ executionId: crypto.randomUUID(), workflowId, definition: def, registry, services: svc, triggerItems: [{ json: body as Record<string, unknown> }] });

  it('looks up the booking, answers once and replies to GoHighLevel with valid JSON', async () => {
    const ai = fakeAi(['{"lookup":"Booking Details","find":"WB-1029"}', '{"reply":"Hi \\"Ana\\"!\\nYour unit is A-12-3."}']);
    const def = willowDefinition();
    const r = await run(def, webhookBody('Hi, my booking is WB-1029. Which unit?'), services(ai));
    expect(r.status).toBe('success');

    // The instructions come from the sheet's first row only (Limit 1), plus the system data.
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[0]!.system).toMatch(/^You are Willow, the Widebed guest assistant\./);
    expect(ai.calls[0]!.system).toContain('User Name: Ana Lee');
    expect(ai.calls[0]!.system).toMatch(/Today's Date: \d{4}-\d{2}-\d{2}/);
    expect(ai.calls[0]!.system).toContain('"Booking Details"');
    expect(ai.calls[0]!.json).toBe(true);
    expect(ai.calls[1]!.prompt).toContain('Search in "Booking Details" for "WB-1029": 1 row(s) found');
    expect(ai.calls[1]!.prompt).toContain('A-12-3');
    expect(ai.calls[1]!.prompt).not.toContain('Ben Tan'); // only matching rows reach the AI

    // GoHighLevel got exactly one message; quotes and new lines survived as JSON.
    expect(web.ghl).toHaveLength(1);
    expect(web.ghl[0]!.body).toEqual({ type: 'Live_Chat', contactId: 'contact-ana', message: 'Hi "Ana"!\nYour unit is A-12-3.' });
    expect(web.ghl[0]!.headers.Authorization).toBe('Bearer pit-secret');
    expect(Object.keys(web.ghl[0]!.headers).filter((h) => h.toLowerCase() === 'content-type')).toHaveLength(1);
    const botId = def.nodes.find((n) => n.type === 'ai.chatbot')!.id;
    expect(r.outputs[botId]!.main!.map((i) => [i.json.output, i.json.lookups])).toEqual([['Hi "Ana"!\nYour unit is A-12-3.', [{ list: 'Booking Details', find: 'WB-1029', found: 1 }]]]);
  });

  it('remembers the conversation per contact, and only within this workflow', async () => {
    const ai = fakeAi(['{"reply":"It is on level 3."}']);
    await run(willowDefinition(), webhookBody('Where do I park?'), services(ai));
    expect(ai.calls[0]!.prompt).toContain('Person: Hi, my booking is WB-1029. Which unit?');
    expect(ai.calls[0]!.prompt).toContain('You: Hi "Ana"!');

    const other = fakeAi(['{"reply":"Hello!"}']);
    await run(willowDefinition(), webhookBody('Hello', 'contact-ben'), services(other));
    expect(other.calls[0]!.prompt).not.toContain('Conversation so far');

    const otherWorkflow = fakeAi(['{"reply":"Hello!"}']);
    await run(willowDefinition(), webhookBody('Hi again'), services(otherWorkflow, 'wf_other'), 'wf_other');
    expect(otherWorkflow.calls[0]!.prompt).not.toContain('Conversation so far');

    expect((await chatMemoryFor(repos, 'wf_willow').load('contact-ana')).map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('finds phone numbers written differently and stops searching at the limit', async () => {
    expect(searchRows([{ Phone: '+60 12-345 6789', row_number: 2 }, { Phone: '60198887777', row_number: 3 }], '0123456789')).toHaveLength(1);
    expect(searchRows([{ Guest: 'Ana Lee' }, { Guest: 'Ben Tan' }], 'ana LEE')).toEqual([{ Guest: 'Ana Lee' }]);

    const def = willowDefinition();
    const bot = def.nodes.find((n) => n.type === 'ai.chatbot')!;
    bot.config.maxLookups = 2;
    const ai = fakeAi(['{"lookup":"Booking Details","find":"x"}', '{"lookup":"Nope","find":"y"}', '{"reply":"Sorry, I could not find it."}']);
    const r = await run(def, webhookBody('Find something', 'contact-limit'), services(ai));
    expect(r.status).toBe('success');
    expect(ai.calls).toHaveLength(3);
    expect(ai.calls[1]!.prompt).toContain('Nothing found.');
    expect(ai.calls[2]!.prompt).toContain('There is no list called "Nope"');
    expect(ai.calls[2]!.prompt).toContain('You cannot search any more now');
  });

  it('never sends an API key to a website that is not on the connection', async () => {
    const def = willowDefinition();
    def.nodes.find((n) => n.type === 'data.httpRequest')!.config.url = 'https://evil.example.com/collect';
    const before = web.ghl.length;
    const r = await run(def, webhookBody('Hi', 'contact-x'), services(fakeAi(['{"reply":"Hi"}'])));
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r)).toMatch(/may only be sent to services\.leadconnectorhq\.com/);
    expect(web.ghl.length).toBe(before);
  });

  it('Limit keeps the first or last items', async () => {
    const def: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', name: 't', position: { x: 0, y: 0 }, config: {} },
        { id: 'l', type: 'logic.limit', name: 'l', position: { x: 0, y: 0 }, config: { maxItems: 2, keep: 'last' } },
      ],
      connections: [{ id: 'e', source: 't', sourceHandle: 'main', target: 'l', targetHandle: 'main' }],
      settings: {},
    };
    const r = await runWorkflow({ executionId: 'e', workflowId: 'w', definition: def, registry, services: { http: web.http as any }, triggerItems: [1, 2, 3].map((n) => ({ json: { n } })) });
    expect(r.outputs.l!.main!.map((i) => i.json.n)).toEqual([2, 3]);
  });
});

/* ------------------------------------------------------------- API: keys */

describe('API key connections and connection fields', () => {
  const people: Record<string, { role: string; department: string | null }> = {
    it: { role: 'it_admin', department: 'IT' },
    ops: { role: 'department_manager', department: 'Ops' },
    sales: { role: 'department_manager', department: 'Sales' },
  };
  const verifier: TokenVerifier = { verify: async (t) => ({ uid: t.replace('tok-', ''), email: `${t}@x.com`, name: t, emailVerified: true }) };
  const as = (uid: string) => ({ Authorization: `Bearer tok-${uid}` });
  const repos = createMemoryRepositories();
  const ctx = buildContext(loadConfig({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: 't', ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), RATE_LIMIT_PER_MINUTE: '10000' } as any), repos, verifier);
  startProcessing(ctx);
  const app = createApp(ctx);
  let keyId = '';

  beforeAll(async () => {
    for (const [uid, p] of Object.entries(people)) {
      await repos.users.create({ uid, name: uid, email: `${uid}@x.com`, role: p.role as any, department: p.department, status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null });
    }
  });

  it('stores the key encrypted, shows only its ending and checks where it may go', async () => {
    const bad = await request(app).post('/api/credentials/api-key').set(as('it')).send({ name: 'GHL', headerName: 'Authorization', value: 'Bearer pit-123456789', allowedDomains: [] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message ?? bad.text).toMatch(/at least one website/);
    expect((await request(app).post('/api/credentials/api-key').set(as('ops')).send({ name: 'x', value: 'y', allowedDomains: ['a.com'] })).status).toBe(403);

    const res = await request(app).post('/api/credentials/api-key').set(as('it')).send({ name: 'GoHighLevel', department: 'Ops', headerName: 'Authorization', value: 'Bearer pit-123456789', allowedDomains: ['https://services.leadconnectorhq.com/'] });
    expect(res.status).toBe(201);
    keyId = res.body.credentialId;
    expect(res.body.details).toEqual({ headerName: 'Authorization', allowedDomains: ['services.leadconnectorhq.com'], keyEnding: '6789' });
    expect(JSON.stringify(res.body)).not.toContain('pit-123');
    expect(await repos.credentialSecrets.get(keyId)).not.toContain('pit-123');

    expect(await ctx.credentials.apiKey(keyId, 'Ops')).toMatchObject({ headerName: 'Authorization', value: 'Bearer pit-123456789' });
    await expect(ctx.credentials.apiKey(keyId, 'Sales')).rejects.toThrow(/another department/);

    const patch = await request(app).patch(`/api/credentials/${keyId}`).set(as('it')).send({ value: 'Bearer pit-NEW-0000', headerName: 'X-Api-Key' });
    expect(patch.status).toBe(200);
    expect(patch.body.details.headerName).toBe('X-Api-Key');
    expect((await ctx.credentials.apiKey(keyId, 'Ops')).value).toBe('Bearer pit-NEW-0000');
    expect((await request(app).patch(`/api/credentials/${keyId}`).set(as('it')).send({ headerName: 'Content-Length' })).status).toBe(400);
  });

  it('refuses to save a workflow that uses someone else’s connection inside a step', async () => {
    const def = willowDefinition();
    for (const n of def.nodes) n.credentialId = n.credentialId === undefined ? undefined : null;
    def.nodes.find((n) => n.type === 'data.httpRequest')!.config.auth = keyId; // Ops-only key
    def.nodes.find((n) => n.type === 'ai.chatbot')!.config.googleConnection = '';
    const created = await request(app).post('/api/workflows').set(as('sales')).send({ name: 'Sales bot' });
    expect(created.status).toBe(201);
    const id = created.body.workflowId;
    const put = await request(app).put(`/api/workflows/${id}/draft`).set(as("sales")).send({ definition: def });
    expect(put.status).toBe(403);
    def.nodes.find((n) => n.type === 'data.httpRequest')!.config.auth = '';
    expect((await request(app).put(`/api/workflows/${id}/draft`).set(as("sales")).send({ definition: def })).status).toBe(200);
  });

  it('imports Willow through the API and the editor lists the new node types', async () => {
    const imp = await request(app).post('/api/workflows/import').set(as('ops')).send({ file: willow });
    expect(imp.status).toBe(201);
    expect(imp.body.report.unsupported).toEqual([]);
    const types = await request(app).get('/api/node-types').set(as('ops'));
    const list = types.body.nodes as any[];
    const bot = list.find((d) => d.type === 'ai.chatbot');
    expect(bot.fields.find((f: any) => f.key === 'googleConnection')).toMatchObject({ type: 'credential', credentialProvider: 'google_oauth' });
    expect(bot.fields.find((f: any) => f.key === 'lookups').itemFields.map((f: any) => f.key)).toEqual(['name', 'spreadsheet', 'sheet', 'description']);
    expect(list.some((d) => d.type === 'logic.limit')).toBe(true);
  });
});

/* ------------------------------------------------- Vercel: webhook waits */

describe('Webhook calls on Vercel without Redis', () => {
  const verifier: TokenVerifier = { verify: async (t) => ({ uid: t.replace('tok-', ''), email: `${t}@x.com`, name: t, emailVerified: true }) };
  const repos = createMemoryRepositories();
  const ctx = buildContext(
    loadConfig({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: 't', ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), RATE_LIMIT_PER_MINUTE: '10000', VERCEL: '1', WEBHOOK_WAIT_SECONDS: '10', PUBLIC_BASE_URL: 'https://automation.test' } as any),
    repos,
    verifier,
  );
  startProcessing(ctx);
  const app = createApp(ctx);

  it('keeps the call open until the run has finished, so Vercel does not pause it halfway', async () => {
    expect(ctx.config.webhookWaitMs).toBe(10_000);
    await repos.users.create({ uid: 'boss', name: 'boss', email: 'boss@x.com', role: 'super_admin', department: null, status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null });
    const as = { Authorization: 'Bearer tok-boss' };
    const id = (await request(app).post('/api/workflows').set(as).send({ name: 'Slow hook' })).body.workflowId;
    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: 'hook', type: 'trigger.webhook', name: 'Hook', position: { x: 0, y: 0 }, config: { method: 'POST', requireSignature: false } },
        { id: 'w', type: 'logic.wait', name: 'Think', position: { x: 200, y: 0 }, config: { amount: 1, unit: 'seconds' } },
      ],
      connections: [{ id: 'c', source: 'hook', sourceHandle: 'main', target: 'w', targetHandle: 'main' }],
      settings: {},
    };
    await request(app).put(`/api/workflows/${id}/draft`).set(as).send({ definition });
    const url: string = (await request(app).post(`/api/workflows/${id}/publish`).set(as)).body.issuedWebhooks[0].url;
    await request(app).post(`/api/workflows/${id}/activate`).set(as);
    const started = Date.now();
    const hook = await request(app).post(`/hooks/${url.split('/hooks/')[1]}`).set('content-type', 'application/json').send({ message: { body: 'hi' } });
    expect(hook.status).toBe(202);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect((await repos.executions.get(hook.body.executionId))!.status).toBe('success');
  });
});

/* ---------------------------------------------- website chat box (reply) */

describe('Website chat box: webhook that sends back the reply', () => {
  const verifier: TokenVerifier = { verify: async (t) => ({ uid: t.replace('tok-', ''), email: `${t}@x.com`, name: t, emailVerified: true }) };
  const repos = createMemoryRepositories();
  const ctx = buildContext(loadConfig({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: 't', ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), RATE_LIMIT_PER_MINUTE: '10000', PUBLIC_BASE_URL: 'https://automation.test' } as any), repos, verifier);
  startProcessing(ctx);
  const app = createApp(ctx);
  const as = { Authorization: 'Bearer tok-boss' };
  const SITE = 'https://www.widebed.com';
  let token = '';

  const build = async (respond: Record<string, unknown> | null, origins = `${SITE}, https://widebed.com/`) => {
    const id = (await request(app).post('/api/workflows').set(as).send({ name: `Chat ${Math.random()}` })).body.workflowId;
    const nodes: any[] = [{ id: 'hook', type: 'trigger.webhook', name: 'Visitor', position: { x: 0, y: 0 }, config: { method: 'POST', responseMode: 'reply', allowedOrigins: origins } }];
    const connections: any[] = [];
    if (respond) {
      nodes.push({ id: 'r', type: 'comm.respondWebhook', name: 'Reply', position: { x: 200, y: 0 }, config: respond });
      connections.push({ id: 'c', source: 'hook', sourceHandle: 'main', target: 'r', targetHandle: 'main' });
    }
    const definition = { schemaVersion: 1, nodes, connections, settings: {} };
    const save = await request(app).put(`/api/workflows/${id}/draft`).set(as).send({ definition });
    const url: string = (await request(app).post(`/api/workflows/${id}/publish`).set(as)).body.issuedWebhooks[0].url;
    await request(app).post(`/api/workflows/${id}/activate`).set(as);
    return { token: url.split('/hooks/')[1]!, issues: save.body.issues ?? [] };
  };

  beforeAll(async () => {
    await repos.users.create({ uid: 'boss', name: 'boss', email: 'boss@x.com', role: 'super_admin', department: null, status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null });
    token = (await build({ bodyType: 'fields', bodyFields: [{ key: 'reply', value: 'You said: {{ $json.body.message }}' }], statusCode: 200 })).token;
  });

  it('lets the listed website ask first (browser preflight) and refuses other websites', async () => {
    const ok = await request(app).options(`/hooks/${token}`).set('origin', SITE).set('access-control-request-method', 'POST');
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(SITE);
    expect(ok.headers['access-control-allow-headers']).toContain('content-type');
    expect((await request(app).options('/hooks/not-a-real-token-123456').set('origin', SITE)).status).toBe(404);
    // Another website may ask, but its real call is refused with the address to add, and nothing runs.
    const runsBefore = (await repos.executions.list({}, 100)).items.length;
    const blocked = await request(app).post(`/hooks/${token}`).set('origin', 'https://evil.example').set('content-type', 'application/json').send({ message: 'hi' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toContain('https://evil.example');
    expect((await repos.executions.list({}, 100)).items.length).toBe(runsBefore);
  });

  it('answers with the Respond to Webhook step, quotes and new lines intact', async () => {
    const res = await request(app).post(`/hooks/${token}`).set('origin', 'https://widebed.com').set('content-type', 'application/json').send({ message: 'Is "parking" free?\nThanks', sessionId: 'web-1' });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://widebed.com');
    expect(res.body).toEqual({ reply: 'You said: Is "parking" free?\nThanks' });
    // Server-to-server calls (no Origin) still work.
    expect((await request(app).post(`/hooks/${token}`).set('content-type', 'application/json').send({ message: 'x' })).body).toEqual({ reply: 'You said: x' });
    // The stored answer never shows in the Executions API.
    const list = await request(app).get('/api/executions').set(as);
    expect(JSON.stringify(list.body)).not.toContain('webhookResponseJson');
  });

  it('chat boxes can send JSON as text/plain (no preflight) and read why a call failed', async () => {
    const r = await request(app).post(`/hooks/${token}`).set('origin', SITE).set('content-type', 'text/plain;charset=UTF-8').send(JSON.stringify({ message: 'plain' }));
    expect([r.status, r.body]).toEqual([200, { reply: 'You said: plain' }]);
    const gone = await request(app).post('/hooks/not-a-real-token-123456').set('origin', SITE).set('content-type', 'text/plain').send('{"message":"x"}');
    expect(gone.status).toBe(404);
    expect(gone.headers['access-control-allow-origin']).toBe(SITE);
    expect(gone.body.error).toMatch(/not Active, or its webhook URL has changed/);
    // Callers without a browser still get the plain 404.
    expect((await request(app).post('/hooks/not-a-real-token-123456').send({})).body).toEqual({ error: 'Not found' });
  });

  it('names the step that gave no data when the reply never came', async () => {
    const id = (await request(app).post('/api/workflows').set(as).send({ name: 'Empty' })).body.workflowId;
    const definition = { schemaVersion: 1, settings: {}, nodes: [
      { id: 'hook', type: 'trigger.webhook', name: 'Visitor', position: { x: 0, y: 0 }, config: { method: 'POST', responseMode: 'reply', allowedOrigins: '*' } },
      { id: 'f', type: 'logic.filter', name: 'System Prompt', position: { x: 100, y: 0 }, config: { conditions: [{ left: '{{ $json.body.message }}', operator: 'equals', right: 'never' }] } },
      { id: 'r', type: 'comm.respondWebhook', name: 'Reply', position: { x: 200, y: 0 }, config: { bodyType: 'fields', bodyFields: [{ key: 'reply', value: 'x' }] } },
    ], connections: [
      { id: 'c1', source: 'hook', sourceHandle: 'main', target: 'f', targetHandle: 'main' },
      { id: 'c2', source: 'f', sourceHandle: 'main', target: 'r', targetHandle: 'main' },
    ] };
    await request(app).put(`/api/workflows/${id}/draft`).set(as).send({ definition });
    const url: string = (await request(app).post(`/api/workflows/${id}/publish`).set(as)).body.issuedWebhooks[0].url;
    await request(app).post(`/api/workflows/${id}/activate`).set(as);
    const r = await request(app).post(`/api/hooks/${url.split('/hooks/')[1]}`).set('origin', SITE).set('content-type', 'text/plain').send('{"message":"hi"}');
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('The workflow stopped after “System Prompt”: that step gave no data, so the steps after it (and the reply) did not run.');
  });

  it('“*” allows any website, including page builders that run the code in a sandboxed frame', async () => {
    const anySite = await build({ bodyType: 'fields', bodyFields: [{ key: 'reply', value: 'ok' }] }, '*');
    const r = await request(app).post(`/hooks/${anySite.token}`).set('origin', 'null').set('content-type', 'application/json').send({ message: 'x' });
    expect([r.status, r.body, r.headers['access-control-allow-origin']]).toEqual([200, { reply: 'ok' }, 'null']);
  });

  it('“Test run” in the editor uses the Webhook step’s sample request', async () => {
    const id = (await request(app).post('/api/workflows').set(as).send({ name: 'Sample' })).body.workflowId;
    const definition = { schemaVersion: 1, settings: {}, connections: [{ id: 'c', source: 'hook', sourceHandle: 'main', target: 'r', targetHandle: 'main' }], nodes: [
      { id: 'hook', type: 'trigger.webhook', name: 'Visitor', position: { x: 0, y: 0 }, config: { method: 'POST', responseMode: 'reply', testData: '{ "message": "Is parking free?" }' } },
      { id: 'r', type: 'comm.respondWebhook', name: 'Reply', position: { x: 200, y: 0 }, config: { bodyType: 'fields', bodyFields: [{ key: 'reply', value: 'You asked: {{ $json.body.message }}' }] } },
    ] };
    await request(app).put(`/api/workflows/${id}/draft`).set(as).send({ definition });
    const run = await request(app).post(`/api/workflows/${id}/run`).set(as).send({ mode: 'draft' });
    expect(run.status).toBe(202);
    let exec;
    for (let i = 0; i < 50 && exec?.status !== 'success'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      exec = await repos.executions.get(run.body.executionId);
    }
    expect(exec!.status).toBe('success');
    expect(exec!.triggerItems).toEqual([{ json: { body: { message: 'Is parking free?' }, query: {}, headers: { 'content-type': 'application/json' }, method: 'POST', test: true } }]);
  });

  it('plain-text answers, and a clear result when nothing answered', async () => {
    const text = await build({ bodyType: 'text', text: 'Hello {{ $json.body.message }}', statusCode: 201 });
    const r = await request(app).post(`/hooks/${text.token}`).set('content-type', 'application/json').send({ message: 'Ana' });
    expect([r.status, r.text, r.headers['content-type']]).toEqual([201, 'Hello Ana', expect.stringContaining('text/plain')]);

    const none = await build(null);
    expect(none.issues.map((i: any) => i.message).join()).toMatch(/no “Respond to Webhook” step/);
    const r2 = await request(app).post(`/hooks/${none.token}`).set('content-type', 'application/json').send({ message: 'x' });
    expect(r2.status).toBe(500);
    expect(r2.body.error).toMatch(/without a “Respond to Webhook” step/);
  });

  it('imports n8n “Respond to Webhook” and webhooks that wait for it', () => {
    const r = convertN8n({
      name: 'site bot',
      nodes: [
        { id: 'w', name: 'Hook', type: 'n8n-nodes-base.webhook', parameters: { httpMethod: 'POST', responseMode: 'responseNode' } },
        { id: 'r', name: 'Answer', type: 'n8n-nodes-base.respondToWebhook', parameters: { respondWith: 'json', responseBody: '={ "reply": "{{ $json.output }}", "ok": true }' } },
      ],
      connections: { Hook: { main: [[{ node: 'Answer', type: 'main', index: 0 }]] } },
    });
    expect(r.report.unsupported).toEqual([]);
    expect(r.definition.nodes[0]!.config).toMatchObject({ responseMode: 'reply' });
    expect(r.definition.nodes[1]).toMatchObject({ type: 'comm.respondWebhook', config: { bodyType: 'fields', bodyFields: [{ key: 'reply', value: '{{ $json.output }}' }, { key: 'ok', value: true }] } });
  });
});

/* ------------------------------------------- website chat that knows the guest */

describe('Website chat that knows the guest (template)', () => {
  const tpl = BUILT_IN_TEMPLATES.find((t) => t.templateId === 'tpl_ai_website_guest_chat')!;
  const SHEET = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
  function definition(): WorkflowDefinition {
    const def = structuredClone(tpl.definition);
    for (const n of def.nodes) {
      if (n.type === 'data.firebaseRead') n.credentialId = 'cred_pms';
      if (n.type === 'ai.classify') n.credentialId = 'cred_gemini';
      if (n.type === 'comm.sheetsRead') { n.credentialId = 'cred_google'; n.config.spreadsheet = SHEET; }
      if (n.type === 'ai.chatbot') {
        n.credentialId = 'cred_gemini';
        n.config.googleConnection = 'cred_google';
        for (const l of n.config.lookups as any[]) l.spreadsheet = SHEET;
      }
    }
    return def;
  }
  const web = fakeWeb();
  const repos = createMemoryRepositories();
  const guests = [{ id: 'main', data: { kind: 'tenant', name: 'Ana Lee', phone: '012-345 6789', phoneKey: '60123456789', email: 'ana@example.com' } }];
  const bookings = [
    { id: 'offline_DM-014', data: { bookingNo: 'DM-014', tenantId: 'TEN-0001', unitCode: 'A-12-3', propertyName: 'D Majestic', arrival: '2026-12-01', departure: '2026-12-04', status: 'active' } },
    { id: 'offline_DM-020', data: { bookingNo: 'DM-020', tenantId: 'TEN-0009', unitCode: 'B-1-1', propertyName: 'D Majestic', arrival: '2026-12-02', departure: '2026-12-03', status: 'active' } },
  ];
  const queries: any[] = [];
  const fs = {
    query: async (collection: string, o: any) => {
      queries.push({ collection, ...o });
      if (collection === 'offlineBookings') {
        return bookings.filter((b: any) => o.where.every((w: any) => b.data[w.field] === w.value)).slice(0, o.limit).map((b) => ({ ...b, path: `offlineBookings/${b.id}` }));
      }
      return guests.filter((g: any) => o.where.every((w: any) => g.data[w.field] === w.value)).slice(0, o.limit).map((g) => ({ ...g, path: `tenants/TEN-0001/private/${g.id}` }));
    },
    get: async () => null,
  };
  async function run(body: Record<string, unknown>, ai: ReturnType<typeof fakeAi>) {
    const replies: any[] = [];
    const svc: NodeServices = {
      http: web.http as any,
      googleToken: async () => ({ accessToken: 'g-token', email: 'support@widebed.com', scopes: [] }),
      ai: ai.ai,
      firestore: async (id: string) => (expect(id).toBe('cred_pms'), fs),
      chatMemory: chatMemoryFor(repos, 'wf_guest_chat'),
      respond: async (r) => void replies.push(r.body),
    } as any;
    const r = await runWorkflow({ executionId: crypto.randomUUID(), workflowId: 'wf_guest_chat', definition: definition(), registry, services: svc, triggerItems: [{ json: { body, headers: {}, query: {}, method: 'POST' } }] });
    return { r, replies };
  }
  const profile = (phone: string, email: string) => ({ name: 'Ana Lee', phone, phoneKey: phone.replace(/\D/g, ''), countryCode: '+60', phoneNumber: phone.slice(3), email });

  it('is valid once the connections are chosen', () => {
    expect(validateWorkflow(definition(), registry)).toEqual([]);
  });

  it('welcomes back a guest found by phone or email, and greets a new one', async () => {
    let { r, replies } = await run({ action: 'start', sessionId: 's1', profile: profile('+60123456789', 'x@y.com') }, fakeAi([]));
    expect(r.status).toBe('success');
    expect(replies).toEqual([{ reply: expect.stringMatching(/^Welcome back, Ana Lee!/) }]);
    ({ replies } = await run({ action: 'start', sessionId: 's2', profile: profile('+60111111111', 'ana@example.com') }, fakeAi([])));
    expect(replies[0].reply).toMatch(/^Welcome back/);
    ({ replies } = await run({ action: 'start', sessionId: 's3', profile: profile('+60111111111', 'new@example.com') }, fakeAi([])));
    expect(replies[0].reply).toMatch(/^Hi Ana Lee, nice to meet you! What are you looking for/);
    // Found by phone → the email search is skipped (blank filter); not found → email is searched.
    expect(queries.map((q) => [q.collection, q.where.map((w: any) => w.field).join('+')])).toEqual([
      ['tenants/*/private', 'kind+phoneKey'], ['tenants/*/private', 'kind+phoneKey'], ['tenants/*/private', 'kind+email'], ['tenants/*/private', 'kind+phoneKey'], ['tenants/*/private', 'kind+email'],
    ]);
  });

  it('sorts the question and searches the matching tab first, with memory per visitor', async () => {
    const ai = fakeAi(['{"category":"Property Units","reason":"parking"}', '{"lookup":"Best list for this question","find":"A-12-3"}', '{"reply":"Parking is on level 3, bay 12."}']);
    const { r, replies } = await run({ action: 'message', message: 'Where do I park at A-12-3?', sessionId: 's1', profile: profile('+60123456789', 'ana@example.com') }, ai);
    expect(r.status).toBe('success');
    expect(replies).toEqual([{ reply: 'Parking is on level 3, bay 12.' }]);
    expect(ai.calls[1]!.system).toContain('Guest name: Ana Lee');
    expect(ai.calls[1]!.system).toContain('Type of question: Property Units');
    // Bookings come from Widebed PMS (offlineBookings of this tenant), not from a sheet.
    expect(ai.calls[1]!.system).toContain('DM-014: A-12-3 at D Majestic, 2026-12-01 to 2026-12-04 (active)');
    expect(ai.calls[1]!.system).not.toContain('DM-020');
    expect(queries.at(-1)).toMatchObject({ collection: 'offlineBookings', where: [{ field: 'tenantId', op: '==', value: 'TEN-0001' }], limit: 10 });
    expect(ai.calls[2]!.prompt).toContain('Level 3, bay 12');
    expect(web.sheetReads).toContain('Property Units');
    expect((await chatMemoryFor(repos, 'wf_guest_chat').load('s1')).length).toBe(2);
  });

  it('a visitor whose phone is not in the PMS gets no bookings (and no booking query)', async () => {
    const ai = fakeAi(['{"category":"FAQ","reason":"x"}', '{"reply":"Check-in is from 3 pm."}']);
    const before = queries.length;
    const { replies } = await run({ action: 'message', message: 'Check-in time?', sessionId: 's9', profile: profile('+60199999999', 'zz@example.com') }, ai);
    expect(replies).toEqual([{ reply: 'Check-in is from 3 pm.' }]);
    expect(ai.calls[1]!.system).toContain('No booking found for this phone number.');
    expect(queries.slice(before).map((q) => q.collection)).toEqual(['tenants/*/private']);
    expect(web.sheetReads.at(-1)).toBe('System Prompt');
  });

  it('End chat forgets the conversation', async () => {
    const { r, replies } = await run({ action: 'end', sessionId: 's1' }, fakeAi([]));
    expect(r.status).toBe('success');
    expect(replies[0].reply).toMatch(/^Chat ended/);
    expect(await chatMemoryFor(repos, 'wf_guest_chat').load('s1')).toEqual([]);
  });
});

describe('Firebase: search a sub-collection of every document (tenants/*/private)', () => {
  it('recognises the pattern and refuses * in the wrong place', async () => {
    const { groupPattern } = await import('../src/services/credential-service.js');
    expect(groupPattern('tenants')).toBeNull();
    expect(groupPattern('tenants/TEN-1/private')).toBeNull();
    expect(groupPattern('tenants/*/private')).toEqual({ id: 'private' });
    expect(() => groupPattern('*/x/private')).toThrow(/only in place of a document ID/);
    expect(() => groupPattern('tenants/*')).toThrow();
  });
});

describe('Google Sheets: a tab name that does not exist', () => {
  const web = fakeWeb();
  const svc = (): NodeServices => ({ http: web.http as any, googleToken: async () => ({ accessToken: 'g-token', email: 'support@widebed.com', scopes: [] }) } as any);
  const def = (sheet: string): WorkflowDefinition => ({
    schemaVersion: 1, settings: {},
    nodes: [
      { id: 't', type: 'trigger.manual', name: 'Start', position: { x: 0, y: 0 }, config: {} },
      { id: 's', type: 'comm.sheetsRead', name: 'Read', position: { x: 1, y: 0 }, credentialId: 'cred_google', config: { spreadsheet: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`, sheet, headerRow: 1, filters: [], returnMode: 'all', valueMode: 'formatted' } },
    ],
    connections: [{ id: 'c', source: 't', sourceHandle: 'main', target: 's', targetHandle: 'main' }],
  });
  it('names the missing tab and lists the real ones', async () => {
    const r = await runWorkflow({ executionId: 'e1', workflowId: 'w', definition: def('FAQ'), registry, services: svc(), triggerItems: [{ json: {} }] });
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r)).toContain('There is no tab called “FAQ” in this sheet. Its tabs are: “System Prompt”, “Booking Details”, “Property Units”.');
  });
  it('fixes a difference in upper/lower case or spaces by itself', async () => {
    const r = await runWorkflow({ executionId: 'e2', workflowId: 'w', definition: def('property  units '), registry, services: svc(), triggerItems: [{ json: {} }] });
    expect(r.status).toBe('success');
    expect(r.outputs.s!.main!.map((i) => i.json['Unit Number'])).toEqual(['A-12-3']);
  });
});
