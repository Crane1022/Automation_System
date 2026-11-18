import express, { Router } from 'express';
import { z } from 'zod';
import { KNOWLEDGE_LIMITS, ROLES, type KnowledgeDoc } from '@widebed/shared';
import type { AppContext } from '../context.js';
import { ah } from '../middleware/errors.js';
import { badRequest, forbidden } from '../lib/http-error.js';
import { ExtractError, MAX_UPLOAD_BYTES, extractText } from '../services/text-extract.js';

const audience = z.object({
  everyone: z.boolean(),
  departments: z.array(z.string().trim().max(60)).max(50),
  roles: z.array(z.enum(ROLES)).max(ROLES.length),
});
const base = {
  title: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.maxTitle),
  folder: z.string().trim().max(KNOWLEDGE_LIMITS.maxFolder).default(''),
  audience,
  agentIds: z.array(z.string().max(100)).max(100).default([]),
};
const createSchema = z.object({
  ...base,
  text: z.string().max(KNOWLEDGE_LIMITS.maxChars + 1000),
  source: z.enum(['typed', 'upload']).default('typed'),
  fileName: z.string().max(200).nullable().default(null),
  fileKind: z.string().max(20).nullable().default(null),
});
const updateSchema = z.object({
  title: base.title.optional(),
  folder: z.string().trim().max(KNOWLEDGE_LIMITS.maxFolder).optional(),
  audience: audience.optional(),
  agentIds: base.agentIds.optional(),
  text: z.string().max(KNOWLEDGE_LIMITS.maxChars + 1000).optional(),
});

/**
 * /api/knowledge — Company Knowledge.
 * Everyone sees the documents they are allowed to read; only Admins (knowledge.manage) change them.
 * Uploads: the text is read out of the file and the file is thrown away (no file storage).
 */
export function knowledgeRouter(ctx: AppContext) {
  const r = Router();
  const svc = ctx.knowledge;
  const audit = (req: any, action: string, d: KnowledgeDoc) =>
    ctx.audit({ actorId: req.user!.uid, action, resourceType: 'knowledge', resourceId: d.docId, metadata: { title: d.title } });

  r.get('/', ah(async (req, res) => res.json(await svc.list(req.user!))));

  /** Try a search the way AI Staff would (only documents this person may read). */
  r.get('/search', ah(async (req, res) => {
    const q = z.string().max(300).parse(req.query.q ?? '');
    const agentId = z.string().max(100).optional().parse(req.query.agentId || undefined);
    res.json({ items: await svc.search(req.user!, q, { agentId, limit: 8 }) });
  }));

  /**
   * Reads the text out of a file (body = the raw file, ?name=file.pdf) and returns it,
   * so the person can check it before saving. Nothing is stored here.
   */
  r.post('/extract', express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES + 1024 }), ah(async (req, res) => {
    if (!svc.canManage(req.user!)) throw forbidden('Only Admins can add company knowledge');
    const name = z.string().min(1).max(200).parse(req.query.name);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('The file is empty');
    try {
      const out = extractText(name, String(req.headers['content-type'] ?? ''), req.body);
      res.json({ name, kind: out.kind, chars: out.text.length, text: out.text });
    } catch (err) {
      if (err instanceof ExtractError) throw badRequest(err.message);
      throw badRequest('This file could not be read. It may be damaged or password-protected.');
    }
  }));

  r.get('/:id', ah(async (req, res) => res.json(await svc.get(req.user!, req.params.id))));

  r.post('/', ah(async (req, res) => {
    const d = await svc.create(req.user!, createSchema.parse(req.body));
    await audit(req, 'knowledge.create', d);
    res.status(201).json(d);
  }));

  r.patch('/:id', ah(async (req, res) => {
    const d = await svc.update(req.user!, req.params.id, updateSchema.parse(req.body));
    await audit(req, 'knowledge.update', d);
    res.json(d);
  }));

  r.delete('/:id', ah(async (req, res) => {
    const d = await svc.remove(req.user!, req.params.id);
    await audit(req, 'knowledge.delete', d);
    res.status(204).end();
  }));

  return r;
}
