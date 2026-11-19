import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import { photoIds } from '../src/assistant/service.js';
import { aiComplete } from '../src/services/ai-client.js';
import { imageInfo } from '../src/services/image-info.js';
import type { TokenVerifier } from '../src/auth/verifier.js';

/** AI Staff Phase 7b: photos in chat (kept compressed inside the chat, no file storage). */

const calls: any[] = [];
let reply: (body: any) => object = () => ({ answer: 'ok' });

const verifier: TokenVerifier = { verify: async (t) => ({ uid: t.replace('tok-', ''), email: `${t.replace('tok-', '')}@x.com`, name: t.replace('tok-', ''), emailVerified: true }) };
const as = (uid: string) => ({ Authorization: `Bearer tok-${uid}` });
const repos = createMemoryRepositories();
const ctx = buildContext(
  loadConfig({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: 't', ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), RATE_LIMIT_PER_MINUTE: '100000', ASSISTANT_BROWSER: 'false' } as any),
  repos,
  verifier,
  {
    credentialOverrides: {
      aiFetch: async (_url, init) => {
        const body = JSON.parse(init.body ?? '{}');
        const last = body.messages?.at(-1)?.content;
        if (last === 'Reply with the word OK.') return { status: 200, json: { model: body.model, choices: [{ message: { content: 'OK' } }] } };
        calls.push(body);
        return { status: 200, json: { model: body.model, choices: [{ message: { content: JSON.stringify(reply(body)) } }] } };
      },
    },
  },
);
startProcessing(ctx);
const app = createApp(ctx);

/** Smallest valid-looking PNG / JPEG headers with a given size. */
function png(w: number, h: number, extra = 0) {
  const b = Buffer.alloc(33 + extra);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function jpeg(w: number, h: number) {
  // SOI, APP0 (len 16), SOF0 (len 17)
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
const imagesIn = (body: any) => (Array.isArray(body.messages?.at(-1)?.content) ? body.messages.at(-1).content.filter((c: any) => c.type === 'image_url') : []);
const textIn = (body: any) => {
  const c = body.messages?.at(-1)?.content;
  return Array.isArray(c) ? c.find((x: any) => x.type === 'text').text : c;
};

async function newChat(uid = 'amy') {
  return (await request(app).post('/api/assistant/chats').set(as(uid)).send({})).body.chatId as string;
}
async function upload(chatId: string, bytes: Buffer, name = 'leak.jpg', uid = 'amy') {
  return request(app).post(`/api/assistant/chats/${chatId}/images?name=${encodeURIComponent(name)}`).set(as(uid)).set('Content-Type', 'application/octet-stream').send(bytes);
}
async function say(chatId: string, body: object, uid = 'amy') {
  const res = await request(app).post(`/api/assistant/chats/${chatId}/messages`).set(as(uid)).send(body);
  if (res.status === 202) await ctx.assistant.idle(chatId);
  return res;
}

beforeAll(async () => {
  for (const [uid, role] of [['it', 'it_admin'], ['amy', 'employee'], ['ben', 'employee']] as const) {
    await repos.users.create({ uid, name: uid.toUpperCase(), email: `${uid}@x.com`, role, department: 'Ops', status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null });
  }
  const aiId = (await request(app).post('/api/credentials/ai').set(as('it')).send({ name: 'OpenAI', service: 'openai', apiKey: 'sk-test-key-0000' })).body.credentialId;
  await request(app).put('/api/assistant/settings').set(as('it')).send({ enabled: true, aiCredentialId: aiId, pmsCredentialId: null, browserEnabled: false });
});

describe('Recognising photos', () => {
  it('reads type and size from the bytes, not the name', () => {
    expect(imageInfo(png(640, 480))).toEqual({ mime: 'image/png', width: 640, height: 480 });
    expect(imageInfo(jpeg(1600, 1200))).toEqual({ mime: 'image/jpeg', width: 1600, height: 1200 });
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([10, 0, 20, 0]), Buffer.alloc(20)]);
    expect(imageInfo(gif)).toEqual({ mime: 'image/gif', width: 10, height: 20 });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBPVP8X', 8, 'latin1');
    webp.writeUIntLE(799, 24, 3);
    webp.writeUIntLE(599, 27, 3);
    expect(imageInfo(webp)).toEqual({ mime: 'image/webp', width: 800, height: 600 });
    expect(imageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });
});

describe('Sending photos to each AI service', () => {
  const img = [{ mime: 'image/jpeg', data: 'QUJD' }];
  const capture = async (service: 'openai' | 'anthropic' | 'gemini', status = 200, json: any = {}) => {
    let sent: any;
    const res = await aiComplete({ service, model: 'm', apiKey: 'k' }, { prompt: 'What is this?', images: img }, async (_u, init) => {
      sent = JSON.parse(init.body!);
      return { status, json };
    }).catch((e) => e);
    return { sent, res };
  };
  it('uses the right format for OpenAI, Claude and Gemini', async () => {
    expect((await capture('openai', 200, { choices: [{ message: { content: 'x' } }] })).sent.messages[0].content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
    ]);
    expect((await capture('anthropic', 200, { content: [{ type: 'text', text: 'x' }] })).sent.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
      { type: 'text', text: 'What is this?' },
    ]);
    expect((await capture('gemini', 200, { candidates: [{ content: { parts: [{ text: 'x' }] } }] })).sent.contents[0].parts).toEqual([
      { inline_data: { mime_type: 'image/jpeg', data: 'QUJD' } },
      { text: 'What is this?' },
    ]);
  });
  it('explains plainly when the model can’t see pictures', async () => {
    const { res } = await capture('openai', 400, { error: { message: 'Invalid content type. image_url is only supported by certain models.' } });
    expect(res.message).toContain('can’t look at pictures');
  });
});

describe('Photos in a chat', () => {
  it('uploads into the chat, only the owner can see it, and the AI gets it with the message', async () => {
    const chatId = await newChat();
    const up = await upload(chatId, jpeg(1200, 900), 'ceiling leak A-12.jpg');
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ name: 'ceiling leak A-12.jpg', width: 1200, height: 900 });
    const get = await request(app).get(`/api/assistant/chats/${chatId}/images/${up.body.imageId}`).set(as('amy'));
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toBe('image/jpeg');
    expect((await request(app).get(`/api/assistant/chats/${chatId}/images/${up.body.imageId}`).set(as('ben'))).status).toBe(404);
    expect((await upload(chatId, jpeg(10, 10), 'x.jpg', 'ben')).status).toBe(404);

    calls.length = 0;
    reply = (body) => ({ answer: imagesIn(body).length === 1 && textIn(body).includes('ceiling leak A-12.jpg') ? 'I can see a water stain.' : 'no photo' });
    expect((await say(chatId, { text: 'What is wrong here?', imageIds: [up.body.imageId] })).status).toBe(202);
    expect(imagesIn(calls[0])[0].image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(calls[0].messages[0].content).toContain('you can SEE the photo');
    const { messages } = (await request(app).get(`/api/assistant/chats/${chatId}`).set(as('amy'))).body;
    expect(messages.at(-1).text).toBe('I can see a water stain.');
    expect(messages.find((m: any) => m.role === 'user').images).toEqual([{ imageId: up.body.imageId, name: 'ceiling leak A-12.jpg', width: 1200, height: 900 }]);
    // The photo data is not inside the messages.
    expect(JSON.stringify(messages)).not.toContain('base64');

    // Later questions in the same chat still let the AI see it.
    calls.length = 0;
    await say(chatId, { text: 'Is it urgent?' });
    expect(imagesIn(calls[0])).toHaveLength(1);

    // A photo can be used in one message only.
    expect((await say(chatId, { text: 'again', imageIds: [up.body.imageId] })).status).toBe(400);
  });

  it('a photo from another chat can’t be sent, and a photo alone is a valid message', async () => {
    const a = await newChat();
    const b = await newChat();
    const up = await upload(a, png(50, 50), 'meter.png');
    expect((await say(b, { text: 'x', imageIds: [up.body.imageId] })).status).toBe(400);
    reply = () => ({ answer: 'Meter reads 0451.' });
    expect((await say(a, { text: '', imageIds: [up.body.imageId] })).status).toBe(202);
    const body = (await request(app).get(`/api/assistant/chats/${a}`).set(as('amy'))).body;
    expect(body.chat.title).toBe('meter.png');
    expect(body.messages.at(-1).text).toBe('Meter reads 0451.');
  });

  it('refuses things that are not photos, and photos that are too big', async () => {
    const chatId = await newChat();
    const svg = await upload(chatId, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'x.svg');
    expect(svg.status).toBe(400);
    expect((await upload(chatId, png(4000, 3000, 720 * 1024), 'huge.png')).status).toBe(413);
    expect((await upload(chatId, png(4000, 3000, 700 * 1024 - 33 + 1), 'big.png')).status).toBe(400);
  });

  it('the AI looks at the 4 newest photos at most; deleting the chat deletes its photos', async () => {
    const chatId = await newChat();
    reply = () => ({ answer: 'ok' });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const two = [(await upload(chatId, png(10 + i, 10), `p${i}a.png`)).body.imageId, (await upload(chatId, png(10 + i, 10), `p${i}b.png`)).body.imageId];
      ids.push(...two);
      calls.length = 0;
      await say(chatId, { text: `set ${i}`, imageIds: two });
    }
    expect(imagesIn(calls[0])).toHaveLength(4);
    expect(photoIds(JSON.parse((await repos.assistant.getChat(chatId))!.transcriptJson!))).toEqual([ids[5], ids[4], ids[3], ids[2]]);
    expect(await repos.assistant.countImages(chatId)).toBe(6);
    await request(app).delete(`/api/assistant/chats/${chatId}`).set(as('amy'));
    expect(await repos.assistant.countImages(chatId)).toBe(0);
  });
});

describe('Website login helpers', () => {
  it('tells words from CSS, and turns Playwright errors into plain words', async () => {
    const { looksLikeCss, friendlyBrowserError } = await import('../src/assistant/browser.js');
    for (const w of ['Email', 'Username', 'IC number', 'Login']) expect(looksLikeCss(w)).toBe(false);
    for (const c of ['#email', '.login input', 'input[name=user]', 'input', 'form > button']) expect(looksLikeCss(c)).toBe(true);
    const raw = 'locator.fill: Timeout 20000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator(\'Email\').first()\u001b[22m';
    expect(friendlyBrowserError(new Error(raw)).message).toBe('The page didn’t respond in time (it may be slow, or covered by a pop-up). Read the page and try again.');
    expect(friendlyBrowserError(new Error('Couldn’t click “Login”: something on the page covers it.')).message).toBe('Couldn’t click “Login”: something on the page covers it.');
  });
});
