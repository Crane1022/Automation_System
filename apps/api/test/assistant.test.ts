import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { hostAllowed, type AppUser } from '@widebed/shared';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';
import type { BrowserLauncher, BrowserPage } from '../src/assistant/browser.js';
import { pmsTools } from '../src/assistant/tools.js';
import { runAgent } from '../src/assistant/agent.js';

/* ---------------------------------------------------------------- fake AI */

/** The "brain" decides the next JSON reply from what the AI was sent. Tests replace it. */
type Brain = (prompt: string, system: string) => object;
let brain: Brain = () => ({ answer: 'Hello!' });
const aiPrompts: string[] = [];

/* ----------------------------------------------------------- fake browser */

const browserLog: string[] = [];
let pageState = { url: '', text: '', loggedIn: false, otp: '' };
const fakeLauncher: BrowserLauncher = {
  async open(allowed) {
    const page: BrowserPage = {
      async goto(url) {
        if (!hostAllowed(new URL(url).hostname, allowed)) throw new Error('blocked');
        pageState.url = url;
        pageState.text = pageState.loggedIn ? 'My bills' : 'Login: email, password';
        browserLog.push(`goto ${url}`);
      },
      url: () => pageState.url,
      title: async () => 'myTNB',
      text: async () => pageState.text,
      links: async () => [{ text: 'Bills', href: 'https://www.mytnb.com.my/bills' }],
      async fill(field, value) {
        browserLog.push(`fill ${field}=${value}`);
        if (/otp/i.test(field)) {
          pageState.otp = value;
          pageState.loggedIn = value === '123456';
          pageState.text = pageState.loggedIn ? 'Welcome. Bills: Oct 2026 RM 120.50 unpaid' : 'Wrong code';
        }
      },
      async click(target) {
        browserLog.push(`click ${target}`);
      },
      async login(u, p) {
        browserLog.push(`login ${u}/${p === 'S3cret!pass' ? 'PASSWORD' : 'wrong'}`);
        pageState.text = 'Enter the OTP sent to your phone';
      },
      async download(target) {
        browserLog.push(`download ${target}`);
        return { name: 'bill-oct-2026.pdf', data: Buffer.from('%PDF-1.4 fake') };
      },
      screenshot: async () => Buffer.from('jpeg'),
      close: async () => void browserLog.push('close'),
    };
    return page;
  },
};

/* ------------------------------------------------------------------ app */

const people: Record<string, { role: string; department: string | null }> = {
  it: { role: 'it_admin', department: 'IT' },
  ops: { role: 'department_manager', department: 'Ops' },
  emp: { role: 'employee', department: 'Ops' },
};
const verifier: TokenVerifier = { verify: async (t) => ({ uid: t.replace('tok-', ''), email: `${t}@x.com`, name: t, emailVerified: true }) };
const as = (uid: string) => ({ Authorization: `Bearer tok-${uid}` });
const repos = createMemoryRepositories();
const ctx = buildContext(
  loadConfig({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: 't', ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), RATE_LIMIT_PER_MINUTE: '100000', ASSISTANT_FILES_DIR: path.join(os.tmpdir(), `wb-asst-${Date.now()}`) } as any),
  repos,
  verifier,
  {
    browserLauncher: fakeLauncher,
    assistantWorkflowWait: { waitMs: 5000, pollMs: 20 },
    credentialOverrides: {
      aiFetch: async (_url, init) => {
        const body = JSON.parse(init.body ?? '{}');
        const system = body.messages?.[0]?.role === 'system' ? body.messages[0].content : '';
        const prompt = body.messages?.at(-1)?.content ?? '';
        aiPrompts.push(`${system}\n${prompt}`);
        if (prompt === 'Reply with the word OK.') return { status: 200, json: { model: body.model, choices: [{ message: { content: 'OK' } }] } };
        return { status: 200, json: { model: body.model, choices: [{ message: { content: JSON.stringify(brain(prompt, system)) } }] } };
      },
    },
  },
);
startProcessing(ctx);
const app = createApp(ctx);

let aiId = '';
let siteId = '';
const user = (uid: string) => repos.users.get(uid) as Promise<AppUser>;

async function chatTurn(uid: string, chatId: string, text: string) {
  const r = await request(app).post(`/api/assistant/chats/${chatId}/messages`).set(as(uid)).send({ text });
  expect(r.status).toBe(202);
  await ctx.assistant.idle(chatId);
  return (await request(app).get(`/api/assistant/chats/${chatId}`).set(as(uid))).body;
}
const lastReply = (body: any) => body.messages.at(-1);

beforeAll(async () => {
  for (const [uid, p] of Object.entries(people)) {
    await repos.users.create({ uid, name: uid, email: `${uid}@x.com`, role: p.role as any, department: p.department, status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null });
  }
  const ai = await request(app).post('/api/credentials/ai').set(as('it')).send({ name: 'OpenAI', service: 'openai', apiKey: 'sk-test-key-0000' });
  aiId = ai.body.credentialId;
});

describe('Assistant setup', () => {
  it('starts switched off and only IT can switch it on', async () => {
    const st = await request(app).get('/api/assistant/status').set(as('ops'));
    expect(st.body).toMatchObject({ enabled: false, ready: false, canManage: false });
    expect((await request(app).put('/api/assistant/settings').set(as('ops')).send({ enabled: true, aiCredentialId: aiId, pmsCredentialId: null, browserEnabled: false })).status).toBe(403);
    expect((await request(app).put('/api/assistant/settings').set(as('it')).send({ enabled: true, aiCredentialId: null, pmsCredentialId: null, browserEnabled: false })).status).toBe(400);
    const ok = await request(app).put('/api/assistant/settings').set(as('it')).send({ enabled: true, aiCredentialId: aiId, pmsCredentialId: null, browserEnabled: true });
    expect(ok.status).toBe(200);
    expect((await request(app).get('/api/assistant/status').set(as('ops'))).body).toMatchObject({ ready: true, problem: null, canUsePms: false });
  });

  it('refuses a PMS connection that is not read-only', async () => {
    await repos.credentials.create({ credentialId: 'cred_pms_rw', name: 'PMS (write)', provider: 'firebase_service_account', department: null, ownerId: 'it', status: 'connected', details: { projectId: 'widebed-pmsdashboard', allowedCollections: ['issues'], readOnly: false }, encryptedSecretReference: 'x', lastTestedAt: null, lastTestResult: null, createdAt: '', updatedAt: '' } as any);
    const r = await request(app).put('/api/assistant/settings').set(as('it')).send({ enabled: true, aiCredentialId: aiId, pmsCredentialId: 'cred_pms_rw', browserEnabled: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/read-only/);
  });
});

describe('Chatting and memory', () => {
  it('answers, remembers a fact, and knows it in a new chat', async () => {
    brain = (prompt) =>
      prompt.includes('TOOL RESULT of remember') ? { answer: 'Got it, I will remember that.' } : { say: 'Saving this', tool: 'remember', input: { fact: 'Unit A-12 TNB account is 2200-1111' } };
    const chat = await request(app).post('/api/assistant/chats').set(as('ops')).send({});
    const body = await chatTurn('ops', chat.body.chatId, 'Remember: unit A-12 TNB account is 2200-1111');
    expect(lastReply(body)).toMatchObject({ role: 'assistant', status: 'done', text: 'Got it, I will remember that.' });
    expect(lastReply(body).steps.map((s: any) => s.label)).toEqual(['Remembering this']);
    expect(body.chat.title).toBe('Remember: unit A-12 TNB account is 2200-1111');
    const mem = await request(app).get('/api/assistant/memories').set(as('ops'));
    expect(mem.body.items.map((m: any) => m.text)).toEqual(['Unit A-12 TNB account is 2200-1111']);

    brain = () => ({ answer: 'It is 2200-1111.' });
    const chat2 = await request(app).post('/api/assistant/chats').set(as('ops')).send({});
    await chatTurn('ops', chat2.body.chatId, 'What is the TNB account of A-12?');
    expect(aiPrompts.at(-1)).toContain('Unit A-12 TNB account is 2200-1111');

    // Memories and chats are private.
    expect((await request(app).get(`/api/assistant/chats/${chat2.body.chatId}`).set(as('it'))).status).toBe(404);
    expect((await request(app).delete(`/api/assistant/memories/${mem.body.items[0].memoryId}`).set(as('it'))).status).toBe(404);
    expect((await request(app).delete(`/api/assistant/memories/${mem.body.items[0].memoryId}`).set(as('ops'))).status).toBe(204);
  });

  it('turns a broken AI answer into a plain error message and frees the chat', async () => {
    brain = () => ({ nothing: true });
    const chat = await request(app).post('/api/assistant/chats').set(as('ops')).send({});
    const body = await chatTurn('ops', chat.body.chatId, 'hello');
    expect(lastReply(body).status).toBe('done');
    expect(lastReply(body).text).toMatch(/too many steps/);
    expect(body.chat.status).toBe('idle');
  });
});

describe('Running workflows needs approval', () => {
  let wfId = '';
  beforeAll(async () => {
    const created = await request(app).post('/api/workflows').set(as('ops')).send({ name: 'Say hi' });
    wfId = created.body.workflowId;
    const definition = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', name: 'Start', position: { x: 0, y: 0 }, config: {} },
        { id: 'f', type: 'logic.filter', name: 'Keep', position: { x: 200, y: 0 }, config: { conditions: [{ left: '{{ $json.who }}', operator: 'isNotEmpty', right: '' }] } },
      ],
      connections: [{ id: 'c', source: 't', sourceHandle: 'main', target: 'f', targetHandle: 'main' }],
    };
    await request(app).put(`/api/workflows/${wfId}/draft`).set(as('ops')).send({ definition });
    expect((await request(app).post(`/api/workflows/${wfId}/publish`).set(as('ops'))).status).toBe(200);
  });

  it('waits for “Approve”, then runs the workflow and reports the result', async () => {
    brain = (prompt) =>
      prompt.includes('TOOL RESULT of run_workflow') ? { answer: prompt.includes('"status": "success"') ? 'Done, it ran successfully.' : 'It failed.' } : { say: 'I will run it.', tool: 'run_workflow', input: { workflowId: wfId, workflowName: 'Say hi', data: { who: 'Ana' } } };
    const chat = await request(app).post('/api/assistant/chats').set(as('ops')).send({});
    let body = await chatTurn('ops', chat.body.chatId, 'Run Say hi for Ana');
    expect(lastReply(body).status).toBe('waiting_approval');
    expect(lastReply(body).pending).toMatchObject({ tool: 'run_workflow', label: 'Running workflow Say hi' });
    expect(lastReply(body).pending.details).toMatch(/may send emails/);
    expect(body.chat.status).toBe('waiting');
    expect((await repos.executions.list({ workflowId: wfId }, 10)).items).toHaveLength(0);

    await request(app).post(`/api/assistant/chats/${chat.body.chatId}/decision`).set(as('ops')).send({ approve: true });
    await ctx.assistant.idle(chat.body.chatId);
    body = (await request(app).get(`/api/assistant/chats/${chat.body.chatId}`).set(as('ops'))).body;
    expect(lastReply(body)).toMatchObject({ status: 'done', text: 'Done, it ran successfully.' });
    expect(lastReply(body).steps.map((s: any) => s.label)).toEqual(['You approved', 'Running workflow Say hi']);
    expect((await repos.executions.list({ workflowId: wfId }, 10)).items).toHaveLength(1);
  });

  it('does nothing when you say no', async () => {
    brain = (prompt) => (prompt.includes('said NO') ? { answer: 'OK, I did not run it.' } : { tool: 'run_workflow', input: { workflowId: wfId, workflowName: 'Say hi' } });
    const chat = await request(app).post('/api/assistant/chats').set(as('ops')).send({});
    await chatTurn('ops', chat.body.chatId, 'Run it');
    const before = (await repos.executions.list({ workflowId: wfId }, 10)).items.length;
    await request(app).post(`/api/assistant/chats/${chat.body.chatId}/decision`).set(as('ops')).send({ approve: false });
    await ctx.assistant.idle(chat.body.chatId);
    const body = (await request(app).get(`/api/assistant/chats/${chat.body.chatId}`).set(as('ops'))).body;
    expect(lastReply(body).text).toBe('OK, I did not run it.');
    expect((await repos.executions.list({ workflowId: wfId }, 10)).items.length).toBe(before);
  });
});

describe('PMS tool', () => {
  it('reads with exact filters, flattens rows and caps the number of rows', async () => {
    const calls: any[] = [];
    const fake = { firestoreAccess: async () => ({ query: async (c: string, o: any) => (calls.push({ c, o }), [{ id: 'ISS-1', path: 'issues/ISS-1', data: { title: 'Leak', status: 'open' } }]), get: async () => null }) } as any;
    const [query] = pmsTools(fake, 'cred', 'Ops', ['issues', 'offlineBookings']);
    expect(query!.description).toContain('issues, offlineBookings');
    const res: any = await query!.run({ collection: 'issues', where: [{ field: 'status', op: '==', value: 'open' }], limit: 999 }, { signal: new AbortController().signal, progress() {} });
    expect(res).toEqual({ count: 1, shown: 1, rows: [{ id: 'ISS-1', title: 'Leak', status: 'open' }] });
    expect(calls[0].o.limit).toBe(50);
    await expect(query!.run({ collection: 'issues', where: [{ field: 'x', op: 'like', value: 1 }] }, { signal: new AbortController().signal, progress() {} })).rejects.toThrow(/Unknown filter/);
  });

  it('answers date questions itself (no date maths by the AI), counts, and trims fields', async () => {
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const docs = [
      { id: 'IS-1', path: 'issues/IS-1', data: { title: 'Old leak', status: 'open', createdAt: day(10), body: 'long text' } },
      { id: 'IS-2', path: 'issues/IS-2', data: { title: 'New leak', status: 'open', createdAt: day(1), body: 'long text' } },
      { id: 'IS-3', path: 'issues/IS-3', data: { title: 'Older', status: 'open', createdAt: day(5), body: 'long text' } },
    ];
    const calls: any[] = [];
    const fake = { firestoreAccess: async () => ({ query: async (_c: string, o: any) => (calls.push(o), docs), get: async () => null }) } as any;
    const [query] = pmsTools(fake, 'cred', null, ['issues']);
    const ctxArg = { signal: new AbortController().signal, progress() {} };
    const res: any = await query!.run({ collection: 'issues', dateFilter: { field: 'createdAt', check: 'moreThanDaysAgo', days: 3 }, fields: ['title'] }, ctxArg);
    expect(res.rows).toEqual([{ id: 'IS-1', title: 'Old leak' }, { id: 'IS-3', title: 'Older' }]);
    expect(calls[0].limit).toBe(500);
    expect(await query!.run({ collection: 'issues', countOnly: true }, ctxArg)).toMatchObject({ count: 3 });
    await expect(query!.run({ collection: 'issues', dateFilter: { field: 'createdAt', check: 'someday' } }, ctxArg)).rejects.toThrow(/Unknown date check/);
  });
});

describe('Browser with a saved website login', () => {
  it('checks the website addresses when saving a login', async () => {
    const bad = await request(app).post('/api/credentials/website').set(as('it')).send({ name: 'x', loginUrl: 'http://mytnb.com.my', username: 'a', password: 'b' });
    expect(bad.status).toBe(400);
    const ok = await request(app).post('/api/credentials/website').set(as('it')).send({ name: 'myTNB', loginUrl: 'https://www.mytnb.com.my/login', allowedDomains: ['mytnb.com.my'], username: 'neokahoong@widebed.com', password: 'S3cret!pass' });
    expect(ok.status).toBe(201);
    siteId = ok.body.credentialId;
    expect(ok.body.details).toMatchObject({ loginUrl: 'https://www.mytnb.com.my/login', allowedDomains: ['www.mytnb.com.my', 'mytnb.com.my'], usernameHint: 'ne•••@widebed.com' });
    expect(JSON.stringify(ok.body)).not.toContain('S3cret');
    expect(await repos.credentialSecrets.get(siteId)).not.toContain('S3cret');
  });

  it('signs in without the AI ever seeing the password, pauses for the OTP, and downloads a bill', async () => {
    pageState = { url: '', text: '', loggedIn: false, otp: '' };
    browserLog.length = 0;
    const plan: object[] = [
      { say: 'Opening myTNB', tool: 'browser_open', input: { site: 'myTNB' } },
      { tool: 'browser_login', input: {} },
      { ask: 'myTNB sent a code to your phone. What is it?' },
    ];
    brain = () => plan.shift() ?? { answer: '?' };
    const chat = await request(app).post('/api/assistant/chats').set(as('ops')).send({});
    let body = await chatTurn('ops', chat.body.chatId, 'Get my TNB bills');
    expect(lastReply(body)).toMatchObject({ status: 'waiting_input', text: 'myTNB sent a code to your phone. What is it?' });
    expect(body.screen).toMatchObject({ url: 'https://www.mytnb.com.my/login' });
    expect(browserLog).toContain('login neokahoong@widebed.com/PASSWORD');

    plan.push(
      { tool: 'browser_type', input: { field: 'OTP', text: '123456', pressEnter: true } },
      { tool: 'browser_read', input: {} },
      { tool: 'browser_download', input: { text: 'Download PDF' } },
      { answer: 'You have 1 unpaid bill: Oct 2026, RM 120.50. I attached the PDF.' },
    );
    body = await chatTurn('ops', chat.body.chatId, '123456');
    const reply = lastReply(body);
    expect(reply).toMatchObject({ status: 'done', text: 'You have 1 unpaid bill: Oct 2026, RM 120.50. I attached the PDF.' });
    expect(reply.files.map((f: any) => [f.name, f.size, /^file_/.test(f.fileId)])).toEqual([['bill-oct-2026.pdf', 13, true]]);
    expect(reply.steps.map((s: any) => s.label)).toEqual(['Typing into “OTP”', 'Reading the page', 'Downloading “Download PDF”']);

    // The password never went to the AI; the file can only be fetched by its owner.
    expect(aiPrompts.some((p) => p.includes('S3cret'))).toBe(false);
    const file = reply.files[0].fileId;
    expect((await request(app).get(`/api/assistant/files/${file}`).set(as('it'))).status).toBe(404);
    const dl = await request(app).get(`/api/assistant/files/${file}`).set(as('ops'));
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect((await request(app).get(`/api/assistant/chats/${chat.body.chatId}/screen`).set(as('ops'))).headers['content-type']).toBe('image/jpeg');
  });

  it('refuses other websites, passwords typed by the AI, and asks before risky clicks', async () => {
    const plan: object[] = [
      { tool: 'browser_open', input: { site: 'myTNB' } },
      { tool: 'browser_goto', input: { url: 'https://evil.example.com/steal' } },
      { tool: 'browser_type', input: { field: 'Password', text: 'guess' } },
      { tool: 'browser_click', input: { text: 'Pay now' } },
    ];
    brain = () => plan.shift() ?? { answer: 'done' };
    const chat = await request(app).post('/api/assistant/chats').set(as('ops')).send({});
    const body = await chatTurn('ops', chat.body.chatId, 'try things');
    const reply = lastReply(body);
    const errors = reply.steps.filter((s: any) => s.status === 'error').map((s: any) => s.detail);
    expect(errors[0]).toMatch(/Not allowed: the assistant may only open www.mytnb.com.my, mytnb.com.my/);
    expect(errors[1]).toMatch(/never typed/);
    expect(reply.status).toBe('waiting_approval');
    expect(reply.pending.label).toBe('Clicking “Pay now”');
    expect(browserLog).not.toContain('click Pay now');
  });

  it('does not offer the browser when it is switched off', async () => {
    await request(app).put('/api/assistant/settings').set(as('it')).send({ enabled: true, aiCredentialId: aiId, pmsCredentialId: null, browserEnabled: false });
    brain = (_p, system) => ({ answer: system.includes('browser_open') ? 'has browser' : 'no browser' });
    const chat = await request(app).post('/api/assistant/chats').set(as('ops')).send({});
    expect(lastReply(await chatTurn('ops', chat.body.chatId, 'hi')).text).toBe('no browser');
    await request(app).put('/api/assistant/settings').set(as('it')).send({ enabled: true, aiCredentialId: aiId, pmsCredentialId: null, browserEnabled: true });
  });
});

describe('AI Agent step (scheduled jobs)', () => {
  it('runs the assistant without a person and refuses actions that need approval', async () => {
    const created = await request(app).post('/api/workflows').set(as('ops')).send({ name: 'Agent job' });
    const id = created.body.workflowId;
    const definition = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', name: 'Start', position: { x: 0, y: 0 }, config: {} },
        { id: 'a', type: 'ai.agent', name: 'Agent', position: { x: 200, y: 0 }, config: { goal: 'Check the bills', usePms: false, useWorkflows: true, websites: '', allowActions: false } },
      ],
      connections: [{ id: 'c', source: 't', sourceHandle: 'main', target: 'a', targetHandle: 'main' }],
    };
    expect((await request(app).put(`/api/workflows/${id}/draft`).set(as('ops')).send({ definition })).status).toBe(200);
    brain = (prompt, system) => {
      if (system.includes('browser_open')) return { answer: 'unexpected browser' };
      if (prompt.includes('Not allowed in automatic runs')) return { answer: 'I could not run the workflow without approval.' };
      return { tool: 'run_workflow', input: { workflowId: id, workflowName: 'x' } };
    };
    const run = await request(app).post(`/api/workflows/${id}/run`).set(as('ops')).send({ mode: 'draft' });
    let exec: any;
    for (let i = 0; i < 200; i++) {
      exec = (await request(app).get(`/api/executions/${run.body.executionId}`).set(as('ops'))).body;
      if (['success', 'failed'].includes(exec.status)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(exec.status).toBe('success');
    expect(exec.steps.find((s: any) => s.nodeId === 'a').outputData.main[0]).toMatchObject({ answer: 'I could not run the workflow without approval.' });
  });

  it('the agent loop never asks questions when nobody is there', async () => {
    let n = 0;
    const out = await runAgent({
      ai: async () => ({ text: JSON.stringify(n++ === 0 ? { ask: 'OTP?' } : { answer: 'Needed an OTP, stopped.' }), model: 'm' }),
      context: '',
      tools: [],
      transcript: [{ role: 'user', text: 'x' }],
      interactive: false,
    });
    expect(out).toEqual({ kind: 'answer', text: 'Needed an OTP, stopped.' });
  });

  it('employees can chat but get no PMS data tools', async () => {
    await repos.credentials.create({ credentialId: 'cred_pms_ro', name: 'PMS', provider: 'firebase_service_account', department: null, ownerId: 'it', status: 'connected', details: { projectId: 'widebed-pmsdashboard', allowedCollections: ['issues'], readOnly: true }, encryptedSecretReference: 'x', lastTestedAt: null, lastTestResult: null, createdAt: '', updatedAt: '' } as any);
    await request(app).put('/api/assistant/settings').set(as('it')).send({ enabled: true, aiCredentialId: aiId, pmsCredentialId: 'cred_pms_ro', browserEnabled: false });
    expect((await request(app).get('/api/assistant/status').set(as('emp'))).body.canUsePms).toBe(false);
    expect((await request(app).get('/api/assistant/status').set(as('ops'))).body.canUsePms).toBe(true);
    brain = (_p, system) => ({ answer: system.includes('pms_query') ? 'pms' : 'no pms' });
    const c1 = await request(app).post('/api/assistant/chats').set(as('emp')).send({});
    expect(lastReply(await chatTurn('emp', c1.body.chatId, 'hi')).text).toBe('no pms');
    const c2 = await request(app).post('/api/assistant/chats').set(as('ops')).send({});
    expect(lastReply(await chatTurn('ops', c2.body.chatId, 'hi')).text).toBe('pms');
    expect(await user('emp')).toBeTruthy();
  });
});

describe('Friendly errors', () => {
  it('explains a missing Firestore index instead of a bare 500', async () => {
    const orig = repos.assistant.listChats;
    repos.assistant.listChats = async () => {
      throw Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/…'), { code: 9 });
    };
    const res = await request(app).get('/api/assistant/chats').set(as('ops'));
    repos.assistant.listChats = orig;
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/still preparing/);
  });
});
