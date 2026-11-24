import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { pictureIds } from '@widebed/nodes';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/create-app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import { multipartBoundary, parseMultipart, sniffFileType } from '../src/lib/multipart.js';
import type { TokenVerifier } from '../src/auth/verifier.js';

/**
 * Photos from a website chat box (multipart webhook calls), the AI Chatbot looking at them,
 * and the AI Picture step (Gemini) making a room preview that the chat box shows by link.
 */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(3000)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2000), Buffer.from([0x0d, 0x0a, 0x2d, 0x2d])]); // contains "\r\n--"
const MADE = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('the preview picture')]);

const geminiCalls: any[] = [];
let imageAnswer: (body: any) => any = () => ({ candidates: [{ content: { parts: [{ text: 'Here is your room.' }, { inlineData: { mimeType: 'image/png', data: MADE.toString('base64') } }] }, finishReason: 'STOP' }] });

const verifier: TokenVerifier = { verify: async (t) => ({ uid: t.replace('tok-', ''), email: `${t.replace('tok-', '')}@x.com`, name: t, emailVerified: true }) };
const as = { Authorization: 'Bearer tok-boss' };
const repos = createMemoryRepositories();
const ctx = buildContext(
  loadConfig({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: 't', ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), RATE_LIMIT_PER_MINUTE: '100000', WEBHOOK_RATE_LIMIT_PER_MINUTE: '100000', ASSISTANT_BROWSER: 'false', PUBLIC_BASE_URL: 'https://automation.test', WEBHOOK_MAX_BODY_BYTES: '20000', WEBHOOK_MAX_UPLOAD_BYTES: '200000' } as any),
  repos,
  verifier,
  {
    credentialOverrides: {
      aiFetch: async (url, init) => {
        const body = JSON.parse(init.body ?? '{}');
        const words = (body.contents?.[0]?.parts ?? []).map((p: any) => p.text ?? '').join('');
        if (/Reply with the word OK/.test(words) || /OK\.?$/.test(words)) return { status: 200, json: { candidates: [{ content: { parts: [{ text: 'OK' }] } }] } };
        geminiCalls.push({ url, body });
        if (body.generationConfig?.responseModalities) return { status: 200, json: imageAnswer(body) };
        return { status: 200, json: { candidates: [{ content: { parts: [{ text: 'I can see a bright living room.' }] } }] } };
      },
    },
  },
);
startProcessing(ctx);
const app = createApp(ctx);
let gemini = '';
let openai = '';

/** Builds, publishes and activates a workflow: Webhook → (steps) → Respond to Webhook. Returns the webhook path. */
async function publish(steps: any[], respond: Record<string, string>) {
  const id = (await request(app).post('/api/workflows').set(as).send({ name: `Pictures ${Math.random()}` })).body.workflowId;
  const nodes: any[] = [{ id: 'hook', type: 'trigger.webhook', name: 'Chat message', position: { x: 0, y: 0 }, config: { method: 'POST', responseMode: 'reply', allowedOrigins: '*' } }, ...steps];
  nodes.push({ id: 'r', type: 'comm.respondWebhook', name: 'Reply', position: { x: 900, y: 0 }, config: { bodyType: 'fields', bodyFields: Object.entries(respond).map(([key, value]) => ({ key, value })), statusCode: 200 } });
  const chain = nodes.map((n) => n.id);
  const connections = chain.slice(1).map((t, i) => ({ id: `c${i}`, source: chain[i], sourceHandle: 'main', target: t, targetHandle: 'main' }));
  const save = await request(app).put(`/api/workflows/${id}/draft`).set(as).send({ definition: { schemaVersion: 1, nodes, connections, settings: {} } });
  expect(save.status).toBe(200);
  const pub = await request(app).post(`/api/workflows/${id}/publish`).set(as);
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  await request(app).post(`/api/workflows/${id}/activate`).set(as);
  return '/api/hooks/' + String(pub.body.issuedWebhooks[0].url).split('/hooks/')[1];
}

const chatForm = (req: request.Test) =>
  req.set('origin', 'https://www.widebed.com').field('sessionId', 's_1').field('message', 'Show me a preview').field('history', '[]').attach('file0', PNG, { filename: 'room.png', contentType: 'image/png' });

beforeAll(async () => {
  await repos.users.create({ uid: 'boss', name: 'boss', email: 'boss@x.com', role: 'super_admin', department: null, status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null });
  const g = await request(app).post('/api/credentials/ai').set(as).send({ name: 'Gemini', service: 'gemini', apiKey: 'AIza-test-key-1234' });
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  gemini = g.body.credentialId;
  const o = await request(app).post('/api/credentials/ai').set(as).send({ name: 'OpenAI', service: 'openai', apiKey: 'sk-test-key-123456' }).catch(() => null);
  openai = o?.body?.credentialId ?? '';
});

describe('Reading form data with files', () => {
  it('splits fields and files, keeping file bytes exactly (even ones that contain "\\r\\n--")', () => {
    const b = 'XyZ123';
    const raw = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="message"\r\n\r\nHi there\r\n`),
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file0"; filename="a/b.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      JPEG,
      Buffer.from(`\r\n--${b}--\r\n`),
    ]);
    expect(multipartBoundary(`multipart/form-data; boundary=${b}`)).toBe(b);
    expect(multipartBoundary('application/json')).toBeNull();
    const form = parseMultipart(raw, b);
    expect(form.fields).toEqual({ message: 'Hi there' });
    expect(form.files).toHaveLength(1);
    expect(form.files[0]!.filename).toBe('a_b.jpg');
    expect(form.files[0]!.data.equals(JPEG)).toBe(true);
    expect(sniffFileType(JPEG)).toBe('image/jpeg');
    expect(sniffFileType(PNG)).toBe('image/png');
    expect(sniffFileType(Buffer.from('<html><script>'))).toBeNull();
    expect(() => parseMultipart(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="x"\r\n\r\nno end`), b)).toThrow(/cut off/);
  });

  it('finds file ids in a list of files, one file, JSON text or a comma list', () => {
    const id = 'file_' + 'a'.repeat(32);
    expect(pictureIds([{ fileId: id, url: 'x' }])).toEqual([id]);
    expect(pictureIds({ fileId: id })).toEqual([id]);
    expect(pictureIds(JSON.stringify([{ fileId: id }]))).toEqual([id]);
    expect(pictureIds(`${id}, not-a-file`)).toEqual([id]);
    expect(pictureIds('')).toEqual([]);
  });
});

describe('Webhook calls with photos (website chat box)', () => {
  let hook = '';
  beforeAll(async () => {
    hook = await publish([], { message: '{{ $json.body.message }}', files: '{{ $json.body.files }}', skipped: '{{ $json.body.skippedFiles }}' });
  });

  it('keeps the photo, lists it in body.files and shows it by its link', async () => {
    const res = await chatForm(request(app).post(hook)).attach('file1', Buffer.from('<html><script>alert(1)</script>'), { filename: 'evil.png', contentType: 'image/png' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.message).toBe('Show me a preview');
    expect(res.body.files).toHaveLength(1);
    const f = res.body.files[0];
    expect(f).toMatchObject({ field: 'file0', name: 'room.png', mimeType: 'image/png', size: PNG.length });
    expect(f.url).toMatch(/^https:\/\/automation\.test\/api\/files\/file_[A-Za-z0-9_-]{32}$/);
    expect(res.body.skipped[0]).toContain('evil.png');

    const got = await request(app).get(new URL(f.url).pathname).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.headers['access-control-allow-origin']).toBe('*');
    expect(Buffer.compare(got.body, PNG)).toBe(0);
    // The run itself does not carry the photo bytes (the execution record stays small).
    const runs = await repos.executions.list({}, 100);
    expect(JSON.stringify(runs.items.map((e) => (e as any).triggerItems))).not.toContain(PNG.toString('base64').slice(0, 40));
  });

  it('unknown or malformed file links are 404', async () => {
    expect((await request(app).get('/api/files/file_doesnotexist0000000000000000')).status).toBe(404);
    expect((await request(app).get('/api/files/..%2Fetc')).status).toBe(404);
  });

  it('allows bigger calls with files, but keeps the normal limit for JSON', async () => {
    const big = Buffer.concat([PNG, crypto.randomBytes(60_000)]);
    const ok = await request(app).post(hook).field('message', 'big photo').attach('file0', big, { filename: 'big.png', contentType: 'image/png' });
    expect(ok.status).toBe(200);
    expect(ok.body.files[0].size).toBe(big.length);
    const json = await request(app).post(hook).set('content-type', 'application/json').send({ message: 'x'.repeat(30_000) });
    expect(json.status).toBe(413);
    const tooBig = await request(app).post(hook).field('message', 'huge').attach('file0', Buffer.concat([PNG, crypto.randomBytes(250_000)]), { filename: 'huge.png', contentType: 'image/png' });
    expect(tooBig.status).toBe(413);
  });
});

describe('AI steps with pictures', () => {
  it('the AI Chatbot looks at the photos sent with the message', async () => {
    const hook = await publish(
      [{ id: 'bot', type: 'ai.chatbot', name: 'Answer', position: { x: 300, y: 0 }, credentialId: gemini, config: { message: '{{ $json.body.message }}', instructions: 'You are the Widebed assistant.', pictures: '{{ $json.body.files }}', conversationId: '', memoryMessages: 0, lookups: [], maxLookups: 0, saveAs: 'output' } }],
      { reply: '{{ $json.output }}', seen: '{{ $json.picturesSeen }}' },
    );
    geminiCalls.length = 0;
    const res = await chatForm(request(app).post(hook));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ reply: 'I can see a bright living room.', seen: 1 });
    const parts = geminiCalls[0].body.contents[0].parts;
    expect(parts[0].inline_data).toEqual({ mime_type: 'image/png', data: PNG.toString('base64') });
    expect(parts.at(-1).text).toContain('Show me a preview');
  });

  it('AI Picture makes the preview with Gemini and the chat box gets its link', async () => {
    const hook = await publish(
      [{ id: 'pic', type: 'ai.image', name: 'Room preview', position: { x: 300, y: 0 }, credentialId: gemini, config: { prompt: 'Keep the room. Add a grey sofa.', pictures: '{{ $json.body.files }}', saveAs: 'image' } }],
      { reply: 'Here is a preview', image: '{{ $json.image }}' },
    );
    geminiCalls.length = 0;
    const res = await chatForm(request(app).post(hook));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.image).toMatchObject({ mimeType: 'image/png', size: MADE.length, note: 'Here is your room.' });
    expect(res.body.image.url).toMatch(/\/api\/files\/file_/);
    expect(res.body.image.data).toBeUndefined(); // a link, not megabytes of base64
    const call = geminiCalls[0];
    expect(call.url).toContain('/models/gemini-2.5-flash-image:generateContent');
    expect(call.body.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
    expect(call.body.contents[0].parts[0].inline_data.mime_type).toBe('image/png');
    expect(call.body.contents[0].parts.at(-1).text).toBe('Keep the room. Add a grey sofa.');
    const got = await request(app).get(new URL(res.body.image.url).pathname);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
  });

  it('says clearly when Gemini makes no picture, and that other AI services cannot', async () => {
    imageAnswer = () => ({ candidates: [{ content: { parts: [{ text: 'I cannot help with that.' }] }, finishReason: 'IMAGE_SAFETY' }] });
    const hook = await publish(
      [{ id: 'pic', type: 'ai.image', name: 'Room preview', position: { x: 300, y: 0 }, credentialId: gemini, config: { prompt: 'Add a sofa', pictures: '', saveAs: 'image' } }],
      { image: '{{ $json.image }}' },
    );
    const res = await request(app).post(hook).set('content-type', 'application/json').send({ message: 'x' });
    expect(res.status).toBe(500);
    const runs = (await repos.executions.list({}, 200)).items.filter((e) => e.status === 'failed');
    const steps = await repos.executions.listSteps(runs[0]!.executionId);
    expect(JSON.stringify(steps)).toMatch(/did not make a picture \(IMAGE_SAFETY\)/);

    if (openai) {
      const h2 = await publish(
        [{ id: 'pic', type: 'ai.image', name: 'Room preview', position: { x: 300, y: 0 }, credentialId: openai, config: { prompt: 'Add a sofa', pictures: '', saveAs: 'image' } }],
        { image: '{{ $json.image }}' },
      );
      expect((await request(app).post(h2).set('content-type', 'application/json').send({ message: 'x' })).status).toBe(500);
    }
  });

  it('with “Carry on”, the chat still gets its answer when no picture is made', async () => {
    imageAnswer = () => ({ candidates: [{ content: { parts: [{ text: 'No.' }] }, finishReason: 'IMAGE_SAFETY' }] });
    const hook = await publish(
      [{ id: 'pic', type: 'ai.image', name: 'Room preview', position: { x: 300, y: 0 }, credentialId: gemini, config: { prompt: 'Add a sofa', pictures: 'file_' + 'x'.repeat(32), ifFails: 'continue', saveAs: 'image' } }],
      { reply: 'Text answer', image: '{{ $json.image }}', why: '{{ $json.imageError }}' },
    );
    const res = await request(app).post(hook).set('content-type', 'application/json').send({ message: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Text answer');
    expect(res.body.image || null).toBeNull(); // an empty value becomes ''
    expect(res.body.why).toMatch(/could not be used: .*not found or expired/);
  });

  it('a workflow cannot read another workflow’s photos', async () => {
    const ref = await ctx.files.save({ workflowId: 'wf_other', executionId: null }, PNG, { name: 'x.png', mimeType: 'image/png' });
    expect(await ctx.files.accessFor('wf_mine', 'ex_1').load(ref.fileId)).toBeNull();
    expect((await ctx.files.accessFor('wf_other', 'ex_1').load(ref.fileId))?.mimeType).toBe('image/png');
  });
});
