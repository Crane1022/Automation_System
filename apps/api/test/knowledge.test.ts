import crypto from 'node:crypto';
import zlib from 'node:zlib';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/create-app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import { packTranscript } from '../src/assistant/service.js';
import { chunkText, extractText } from '../src/services/text-extract.js';
import type { TokenVerifier } from '../src/auth/verifier.js';

/** AI Staff Phase 7a: Company Knowledge (text only, no file storage) and chat attachments. */

type Brain = (who: string, prompt: string, system: string) => object | Promise<object>;
let brain: Brain = () => ({ answer: 'ok' });
const systems: Record<string, string[]> = {};
const prompts: string[] = [];

const people: Record<string, { role: string; department: string | null }> = {
  boss: { role: 'admin', department: null },
  it: { role: 'it_admin', department: 'IT' },
  amy: { role: 'employee', department: 'Ops' },
  hana: { role: 'employee', department: 'HR' },
};
const verifier: TokenVerifier = { verify: async (t) => ({ uid: t.replace('tok-', ''), email: `${t.replace('tok-', '')}@x.com`, name: t.replace('tok-', ''), emailVerified: true }) };
const as = (uid: string) => ({ Authorization: `Bearer tok-${uid}` });
const repos = createMemoryRepositories();
const ctx = buildContext(
  loadConfig({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: 't', ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), RATE_LIMIT_PER_MINUTE: '100000', ASSISTANT_BROWSER: 'false' } as any),
  repos,
  verifier,
  {
    agentRetryDelayMs: 10,
    credentialOverrides: {
      aiFetch: async (_url, init) => {
        const body = JSON.parse(init.body ?? '{}');
        const prompt = body.messages?.at(-1)?.content ?? '';
        if (prompt === 'Reply with the word OK.') return { status: 200, json: { model: body.model, choices: [{ message: { content: 'OK' } }] } };
        const system: string = body.messages?.[0]?.content ?? '';
        const who = /You are ([A-Za-z ]+?)(,| —)/.exec(system)?.[1] ?? 'Widebed';
        (systems[who] ??= []).push(system);
        prompts.push(prompt);
        const reply = await brain(who, prompt, system);
        return { status: 200, json: { model: body.model, choices: [{ message: { content: JSON.stringify(reply) } }] } };
      },
    },
  },
);
startProcessing(ctx);
const app = createApp(ctx);

const base = { avatar: '🤖', color: 'slate', description: '', personality: '', communicationStyle: '', responsibilities: [], expertise: [], instructions: '', aiCredentialId: null, model: null, temperature: null, maxOutputTokens: 4000, memoryEnabled: false, maxSteps: 8, allowedUserIds: [], managerIds: [], approverIds: [], allowedRoles: [], status: 'active', templateId: null, canDelegate: false };
const tools = (o: Record<string, unknown> = {}) => ({ memory: false, workflows: false, pms: false, browser: false, websites: 'all', ...o });
const ids: Record<string, string> = {};
const everyone = { everyone: true, departments: [], roles: [] };

async function chat(uid: string, agent: string, text: string, attachments?: object[]) {
  const id = (await request(app).post('/api/assistant/chats').set(as(uid)).send({ agentId: ids[agent] })).body.chatId;
  const sent = await request(app).post(`/api/assistant/chats/${id}/messages`).set(as(uid)).send({ text, ...(attachments ? { attachments } : {}) });
  expect(sent.status).toBe(202);
  await ctx.assistant.idle(id);
  return { id, body: (await request(app).get(`/api/assistant/chats/${id}`).set(as(uid))).body };
}
async function addDoc(o: Record<string, unknown>) {
  const res = await request(app).post('/api/knowledge').set(as('boss')).send({ folder: '', audience: everyone, agentIds: [], ...o });
  expect(res.status).toBe(201);
  return res.body;
}

/** A tiny real PDF: one compressed page using a font with a ToUnicode map and hex strings. */
function makePdf(lines: string[]) {
  const enc = (s: string) => [...s].map((c) => (c.charCodeAt(0) + 100).toString(16).padStart(4, '0')).join('');
  const content = `BT /F1 12 Tf 72 700 Td ${lines.map((l, i) => `${i ? '0 -16 Td ' : ''}<${enc(l)}> Tj`).join(' ')} ET`;
  const chars = [...new Set(lines.join(''))];
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n${chars.length} beginbfchar\n${chars
    .map((c) => `<${(c.charCodeAt(0) + 100).toString(16).padStart(4, '0')}> <${c.charCodeAt(0).toString(16).padStart(4, '0')}>`)
    .join('\n')}\nendbfchar\nendcmap end end`;
  const z1 = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const z2 = zlib.deflateSync(Buffer.from(cmap, 'latin1'));
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n')];
  const obj = (n: number, body: string | Buffer, dict?: string) =>
    parts.push(Buffer.isBuffer(body) ? Buffer.concat([Buffer.from(`${n} 0 obj\n${dict}\nstream\n`), body, Buffer.from('\nendstream\nendobj\n')]) : Buffer.from(`${n} 0 obj\n${body}\nendobj\n`));
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 5 0 R >> >> >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>');
  obj(4, z1, `<< /Length ${z1.length} /Filter /FlateDecode >>`);
  obj(5, '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode 6 0 R >>');
  obj(6, z2, `<< /Length ${z2.length} /Filter /FlateDecode >>`);
  parts.push(Buffer.from('trailer << /Root 1 0 R >>\n%%EOF'));
  return Buffer.concat(parts);
}

beforeAll(async () => {
  for (const [uid, p] of Object.entries(people)) {
    await repos.users.create({ uid, name: uid.toUpperCase(), email: `${uid}@x.com`, role: p.role as any, department: p.department, status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null });
  }
  const aiId = (await request(app).post('/api/credentials/ai').set(as('it')).send({ name: 'OpenAI', service: 'openai', apiKey: 'sk-test-key-0000' })).body.credentialId;
  await request(app).put('/api/assistant/settings').set(as('it')).send({ enabled: true, aiCredentialId: aiId, pmsCredentialId: null, browserEnabled: false });
  const make = async (name: string, o: Record<string, unknown> = {}) => {
    const res = await request(app).post('/api/agents').set(as('boss')).send({ ...base, name, title: name, department: null, visibility: 'company', tools: tools(), ...o });
    expect(res.status).toBe(201);
    ids[name] = res.body.agentId;
  };
  await make('Front Desk');
  await make('Cleaner Bot');
  await make('No Books', { tools: tools({ knowledge: false }) });
});

describe('Reading files (no file storage)', () => {
  it('reads PDF text through fonts with character maps', () => {
    const r = extractText('sop.pdf', '', makePdf(['Late checkout fee is RM 50.', 'Ask the manager first.']));
    expect(r.kind).toBe('pdf');
    expect(r.text).toBe('Late checkout fee is RM 50.\nAsk the manager first.');
  });

  it('explains clearly when a file can’t be read', () => {
    expect(() => extractText('old.doc', '', Buffer.from('xx'))).toThrow('Save as');
    expect(() => extractText('scan.pdf', '', Buffer.from('%PDF-1.4\n1 0 obj << >> endobj'))).toThrow('scan');
  });

  it('splits long text into pieces and keeps headings with their part', () => {
    const text = `# Cleaning\n\n${'Wipe every surface carefully. '.repeat(80)}\n\nChange sheets.`;
    const pieces = chunkText(text, 1500);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= 2250)).toBe(true);
    expect(pieces.join(' ')).toContain('Change sheets.');
  });

  it('the upload endpoint returns only text, and only Admins may use it', async () => {
    const ok = await request(app).post('/api/knowledge/extract?name=fees.pdf').set(as('boss')).set('Content-Type', 'application/octet-stream').send(makePdf(['Pet fee RM 80']));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ name: 'fees.pdf', kind: 'pdf', text: 'Pet fee RM 80' });
    const no = await request(app).post('/api/knowledge/extract?name=fees.pdf').set(as('amy')).set('Content-Type', 'application/octet-stream').send(makePdf(['x']));
    expect(no.status).toBe(403);
    const bad = await request(app).post('/api/knowledge/extract?name=a.exe').set(as('boss')).set('Content-Type', 'application/octet-stream').send(Buffer.from('MZ'));
    expect(bad.status).toBe(400);
  });
});

describe('Company Knowledge documents', () => {
  it('only Admins add documents; everyone else reads what they are allowed to', async () => {
    const d = await addDoc({ title: 'House rules', folder: 'Guests', text: 'Check-in from 3 PM. Check-out by 12 PM. Late checkout fee is RM 50 per hour.' });
    expect(d).toMatchObject({ title: 'House rules', folder: 'Guests', chunkCount: 1, source: 'typed' });
    expect((await request(app).post('/api/knowledge').set(as('amy')).send({ title: 'x', text: 'y', audience: everyone })).status).toBe(403);
    const list = (await request(app).get('/api/knowledge').set(as('amy'))).body;
    expect(list.canManage).toBe(false);
    expect(list.items.map((x: any) => x.title)).toContain('House rules');
    const full = (await request(app).get(`/api/knowledge/${d.docId}`).set(as('amy'))).body;
    expect(full.text).toContain('Late checkout fee is RM 50');
  });

  it('a department-only document is hidden from other departments (list, open and search)', async () => {
    const d = await addDoc({ title: 'Salary review steps', text: 'Salary review happens every March.', audience: { everyone: false, departments: ['HR'], roles: [] } });
    expect((await request(app).get('/api/knowledge').set(as('amy'))).body.items.map((x: any) => x.docId)).not.toContain(d.docId);
    expect((await request(app).get(`/api/knowledge/${d.docId}`).set(as('amy'))).status).toBe(404);
    expect((await request(app).get('/api/knowledge/search?q=salary review').set(as('amy'))).body.items).toHaveLength(0);
    const hana = (await request(app).get('/api/knowledge/search?q=salary review').set(as('hana'))).body.items;
    expect(hana[0]).toMatchObject({ docId: d.docId, title: 'Salary review steps' });
  });

  it('needs at least one reader group', async () => {
    const res = await request(app).post('/api/knowledge').set(as('boss')).send({ title: 'x', text: 'y', audience: { everyone: false, departments: [], roles: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error.message ?? res.body.message ?? JSON.stringify(res.body)).toContain('who can read');
  });

  it('search puts the most relevant piece first', async () => {
    await addDoc({ title: 'Towel guide', text: 'Two towels per guest. Fold towels in thirds. Towels go in the blue bag.' });
    await addDoc({ title: 'Parking', text: 'Guests park at level 3. Lost parking card costs RM 30.' });
    const items = (await request(app).get('/api/knowledge/search?q=how many towels per guest').set(as('amy'))).body.items;
    expect(items[0].title).toBe('Towel guide');
    const parking = (await request(app).get('/api/knowledge/search?q=lost parking card').set(as('amy'))).body.items;
    expect(parking[0].title).toBe('Parking');
  });

  it('editing the text rebuilds the search pieces; deleting removes them', async () => {
    const d = await addDoc({ title: 'Wifi', text: 'The router is in the cupboard.' });
    const ch = await request(app).patch(`/api/knowledge/${d.docId}`).set(as('boss')).send({ text: 'The router is under the TV.' });
    expect(ch.status).toBe(200);
    expect((await request(app).get('/api/knowledge/search?q=router cupboard').set(as('amy'))).body.items.map((x: any) => x.text).join()).not.toContain('cupboard');
    expect((await request(app).get('/api/knowledge/search?q=router').set(as('amy'))).body.items[0].text).toContain('under the TV');
    expect((await request(app).delete(`/api/knowledge/${d.docId}`).set(as('amy'))).status).toBe(403);
    expect((await request(app).delete(`/api/knowledge/${d.docId}`).set(as('boss'))).status).toBe(204);
    expect(await repos.knowledge.chunks(d.docId)).toEqual([]);
  });
});

describe('AI Staff use the knowledge', () => {
  it('an AI employee searches it and answers from it', async () => {
    brain = (_who, prompt) =>
      prompt.includes('TOOL RESULT of search_knowledge')
        ? { answer: prompt.includes('RM 50 per hour') ? 'Late checkout is RM 50 per hour (House rules).' : 'not found' }
        : { tool: 'search_knowledge', input: { query: 'late checkout fee' } };
    const { body } = await chat('amy', 'Front Desk', 'How much is late checkout?');
    expect(body.messages.at(-1).text).toBe('Late checkout is RM 50 per hour (House rules).');
    expect(body.messages.at(-1).steps.map((s: any) => s.label)).toContain('Looking in Company Knowledge: late checkout fee');
    expect(systems['Front Desk']!.at(-1)).toContain('Company Knowledge YES');
  });

  it('documents limited to some AI staff are invisible to the others', async () => {
    await addDoc({ title: 'Deep clean checklist', text: 'Deep clean: descale the kettle monthly.', agentIds: [ids['Cleaner Bot']] });
    brain = (_who, prompt) => (prompt.includes('TOOL RESULT') ? { answer: prompt.includes('descale the kettle') ? 'found' : 'nothing' } : { tool: 'search_knowledge', input: { query: 'descale kettle' } });
    expect((await chat('amy', 'Cleaner Bot', 'kettle?')).body.messages.at(-1).text).toBe('found');
    expect((await chat('amy', 'Front Desk', 'kettle?')).body.messages.at(-1).text).toBe('nothing');
  });

  it('the AI only finds what the person it works for may read', async () => {
    brain = (_who, prompt) => (prompt.includes('TOOL RESULT') ? { answer: prompt.includes('every March') ? 'found' : 'nothing' } : { tool: 'search_knowledge', input: { query: 'salary review' } });
    expect((await chat('amy', 'Front Desk', 'salary?')).body.messages.at(-1).text).toBe('nothing');
    expect((await chat('hana', 'Front Desk', 'salary?')).body.messages.at(-1).text).toBe('found');
  });

  it('an AI employee with Company Knowledge switched off does not get the tool', async () => {
    brain = () => ({ answer: 'hi' });
    await chat('amy', 'No Books', 'hello');
    const sys = systems['No Books']!.at(-1)!;
    expect(sys).toContain('Company Knowledge NO');
    expect(sys).not.toContain('- search_knowledge:');
  });
});

describe('Files attached to a chat message', () => {
  it('reads the file for the message — the AI gets the text, the chat keeps only the name', async () => {
    const ex = await request(app).post('/api/assistant/extract?name=notes.txt').set(as('amy')).set('Content-Type', 'application/octet-stream').send(Buffer.from('Guest in A-12 lost the key card.'));
    expect(ex.status).toBe(200);
    expect(ex.body).toMatchObject({ kind: 'text', truncated: false });
    brain = (_who, prompt) => ({ answer: prompt.includes('lost the key card') && prompt.includes('notes.txt') ? 'Got it: A-12 key card.' : 'no file' });
    const { id, body } = await chat('amy', 'Front Desk', 'Summarise this', [{ name: ex.body.name, kind: ex.body.kind, text: ex.body.text }]);
    expect(body.messages.at(-1).text).toBe('Got it: A-12 key card.');
    const mine = body.messages.find((m: any) => m.role === 'user');
    expect(mine.text).toBe('Summarise this');
    expect(mine.attachments).toEqual([{ name: 'notes.txt', kind: 'text', chars: 32 }]);
    expect(JSON.stringify(await repos.assistant.listMessages(id, 10))).not.toContain('lost the key card');
  });

  it('a message may be just a file', async () => {
    brain = () => ({ answer: 'read it' });
    const { body } = await chat('amy', 'Front Desk', '', [{ name: 'a.txt', kind: 'text', text: 'hello' }]);
    expect(body.chat.title).toBe('a.txt');
  });

  it('old attachment text is dropped first when a chat gets very long', () => {
    const big = 'x'.repeat(5000);
    const t = [
      { role: 'user' as const, text: `first\n\n[Attached file “a.pdf” (pdf) — its text:]\n"""\n${big}\n"""` },
      { role: 'assistant' as const, text: 'ok' },
      { role: 'user' as const, text: `second\n\n[Attached file “b.pdf” (pdf) — its text:]\n"""\n${big}\n"""` },
    ];
    const packed = JSON.parse(packTranscript(t, 8000));
    expect(packed[0].text).toBe('first\n\n[Attached file “a.pdf” — its text was removed to save space]');
    expect(packed[2].text).toContain(big);
  });
});
