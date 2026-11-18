import express, { Router } from 'express';
import { CHAT_IMAGE_LIMITS, KNOWLEDGE_LIMITS } from '@widebed/shared';
import { ExtractError, MAX_UPLOAD_BYTES, extractText } from '../services/text-extract.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ah } from '../middleware/errors.js';
import { badRequest, notFound } from '../lib/http-error.js';

/**
 * /api/assistant — the Widebed Assistant (chat bot with memory and tools).
 * Every signed-in user has their own chats and memory. What the assistant may do
 * depends on the person: their workflows, PMS data (builders only, read-only), and website logins of their department.
 */
export function assistantRouter(ctx: AppContext) {
  const r = Router();
  const svc = ctx.assistant;
  const text = z.string().max(4000);

  /**
   * Reads the text out of a file for a chat message (PDF, Word, Excel, text).
   * The file is NOT stored anywhere — only the text comes back to the browser.
   * Body: the raw file. Query: ?name=file.pdf
   */
  r.post('/extract', express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES + 1024 }), ah(async (req, res) => {
    const name = z.string().min(1).max(200).parse(req.query.name);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('The file is empty');
    try {
      const out = extractText(name, String(req.headers['content-type'] ?? ''), req.body);
      const max = KNOWLEDGE_LIMITS.maxAttachmentChars;
      res.json({ name, kind: out.kind, chars: out.text.length, text: out.text.slice(0, max), truncated: out.text.length > max });
    } catch (err) {
      if (err instanceof ExtractError) throw badRequest(err.message);
      throw badRequest('This file could not be read. It may be damaged or password-protected.');
    }
  }));

  r.get('/status', ah(async (req, res) => res.json(await svc.status(req.user!))));

  r.put('/settings', ah(async (req, res) => {
    const body = z
      .object({ enabled: z.boolean(), aiCredentialId: z.string().max(100).nullable(), pmsCredentialId: z.string().max(100).nullable(), browserEnabled: z.boolean() })
      .parse(req.body);
    const saved = await svc.saveSettings(req.user!, body);
    await ctx.audit({ actorId: req.user!.uid, action: 'assistant.settings', resourceType: 'settings', resourceId: 'assistant', metadata: { ...saved } });
    res.json(saved);
  }));

  const agentId = z.string().max(100).optional();
  r.get('/chats', ah(async (req, res) => res.json({ items: await svc.listChats(req.user!, agentId.parse(req.query.agentId)) })));
  r.post('/chats', ah(async (req, res) => {
    const body = z.object({ text: text.optional(), agentId }).parse(req.body ?? {});
    res.status(201).json(await svc.createChat(req.user!, body.text, body.agentId));
  }));
  /** Live updates for one chat: `text` while the answer is typed, `changed` when steps/status change. */
  r.get('/chats/:id/stream', ah(async (req, res) => {
    let closed = false;
    const unsubscribe = await svc.subscribe(req.user!, req.params.id, (e) => {
      if (!closed) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('event: ready\ndata: {}\n\n');
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
  }));
  r.post('/chats/:id/regenerate', ah(async (req, res) => {
    res.status(202).json(await svc.regenerate(req.user!, req.params.id));
  }));
  r.get('/chats/:id', ah(async (req, res) => res.json(await svc.getChat(req.user!, req.params.id))));
  r.delete('/chats/:id', ah(async (req, res) => {
    await svc.deleteChat(req.user!, req.params.id);
    res.status(204).end();
  }));
  r.post('/chats/:id/messages', ah(async (req, res) => {
    const body = z
      .object({
        text,
        attachments: z
          .array(z.object({ name: z.string().max(200), kind: z.string().max(20), text: z.string().max(KNOWLEDGE_LIMITS.maxAttachmentChars * 2) }))
          .max(KNOWLEDGE_LIMITS.maxAttachments)
          .default([]),
        imageIds: z.array(z.string().max(60)).max(CHAT_IMAGE_LIMITS.perMessage).default([]),
      })
      .parse(req.body);
    res.status(202).json(await svc.send(req.user!, req.params.id, body.text, body.attachments, body.imageIds));
  }));
  /** A photo for the next message (body = the image bytes, already shrunk by the browser). Kept inside the chat. */
  r.post('/chats/:id/images', express.raw({ type: () => true, limit: CHAT_IMAGE_LIMITS.maxBytes + 1024 }), ah(async (req, res) => {
    const name = z.string().min(1).max(200).parse(req.query.name);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('The photo is empty');
    res.status(201).json(await svc.uploadImage(req.user!, req.params.id, name, req.body));
  }));
  r.get('/chats/:id/images/:imageId', ah(async (req, res) => {
    const img = await svc.image(req.user!, req.params.id, req.params.imageId);
    res.setHeader('Content-Type', img.mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(img.bytes);
  }));
  r.post('/chats/:id/decision', ah(async (req, res) => {
    const body = z.object({ approve: z.boolean(), confirmWord: z.string().max(20).optional() }).parse(req.body);
    await svc.decide(req.user!, req.params.id, body.approve, body.confirmWord);
    await ctx.audit({ actorId: req.user!.uid, action: body.approve ? 'assistant.approve' : 'assistant.decline', resourceType: 'assistantChat', resourceId: req.params.id });
    res.status(202).json({ ok: true });
  }));
  r.post('/chats/:id/stop', ah(async (req, res) => {
    await svc.stop(req.user!, req.params.id);
    res.json({ ok: true });
  }));
  // Latest screenshot of the assistant's browser for this chat (JPEG).
  r.get('/chats/:id/screen', ah(async (req, res) => {
    const s = await svc.screen(req.user!, req.params.id);
    if (!s) throw notFound('No browser screenshot yet');
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.end(s.image);
  }));

  r.get('/memories', ah(async (req, res) => res.json({ items: await svc.listMemories(req.user!, agentId.parse(req.query.agentId)) })));
  r.post('/memories', ah(async (req, res) => {
    const body = z.object({ text: z.string().max(300), agentId }).parse(req.body);
    res.status(201).json(await svc.addMemory(req.user!, body.text, body.agentId));
  }));
  r.patch('/memories/:id', ah(async (req, res) => {
    const body = z.object({ text: z.string().max(300) }).parse(req.body);
    const m = await svc.updateMemory(req.user!, req.params.id, body.text);
    // Someone changing another person's memory (an Admin reviewing it) is recorded.
    if (m.ownerId !== req.user!.uid) await ctx.audit({ actorId: req.user!.uid, action: 'memory.edit', resourceType: 'memory', resourceId: m.memoryId, metadata: { ownerId: m.ownerId, agentId: m.agentId ?? null } });
    res.json(m);
  }));
  r.delete('/memories/:id', ah(async (req, res) => {
    const m = await svc.deleteMemory(req.user!, req.params.id);
    if (m.ownerId !== req.user!.uid) await ctx.audit({ actorId: req.user!.uid, action: 'memory.delete', resourceType: 'memory', resourceId: m.memoryId, metadata: { ownerId: m.ownerId, agentId: m.agentId ?? null } });
    res.status(204).end();
  }));

  // Files the assistant downloaded (e.g. bill PDFs). Only their owner can fetch them.
  r.get('/files/:id', ah(async (req, res) => {
    const f = await svc.readFile(req.user!, req.params.id);
    const pdf = /\.pdf$/i.test(f.meta.name);
    res.setHeader('Content-Type', pdf ? 'application/pdf' : 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${f.meta.name.replace(/"/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(f.data);
  }));

  return r;
}
