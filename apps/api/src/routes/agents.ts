import { Router } from 'express';
import { z } from 'zod';
import { AGENT_TEMPLATES, hasPermission, type AiAgent } from '@widebed/shared';
import type { AppContext } from '../context.js';
import { ah } from '../middleware/errors.js';
import { badRequest, forbidden } from '../lib/http-error.js';
import { agentInputSchema } from './schemas.js';

/**
 * /api/agents — AI Staff (AI employees).
 * Everyone signed in sees the agents they may use; only Admins (agent.manage) change them.
 * Instructions and access lists are only returned to Admins.
 */
export function agentsRouter(ctx: AppContext) {
  const r = Router();
  const svc = ctx.assistant;
  const reg = svc.agents;
  const audit = (req: any, action: string, a: AiAgent, metadata: Record<string, unknown> = {}) =>
    ctx.audit({ actorId: req.user!.uid, action, resourceType: 'agent', resourceId: a.agentId, metadata: { name: a.name, ...metadata } });

  r.get('/', ah(async (req, res) => {
    res.json({ items: await svc.summarize(req.user!, await reg.listFor(req.user!)), canManage: reg.canManage(req.user!) });
  }));

  r.get('/templates', ah(async (_req, res) => res.json({ items: AGENT_TEMPLATES })));

  /** Models an AI connection can use, asked from the AI service. */
  r.get('/models', ah(async (req, res) => {
    if (!reg.canManage(req.user!) && !hasPermission(req.user!, 'credential.manage')) throw forbidden();
    const id = z.string().min(1).max(100).parse(req.query.credentialId);
    try {
      res.json(await ctx.credentials.aiModels(id));
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  }));

  r.get('/:id', ah(async (req, res) => {
    const a = await reg.getFor(req.user!, req.params.id);
    const [summary] = await svc.summarize(req.user!, [a]);
    res.json({ summary, ...(reg.canEdit(req.user!, a) ? { agent: a } : {}) });
  }));

  /** Everyone who can chat with it right now (Admins and its managers). */
  r.get('/:id/access', ah(async (req, res) => res.json({ items: await reg.accessList(req.user!, req.params.id) })));

  /** Admins: what it remembers about each person. Viewing is logged. */
  r.get('/:id/memories', ah(async (req, res) => {
    const items = await svc.reviewMemories(req.user!, req.params.id);
    await ctx.audit({ actorId: req.user!.uid, action: 'memory.review', resourceType: 'agent', resourceId: req.params.id, metadata: { count: items.length } });
    res.json({ items });
  }));

  r.post('/', ah(async (req, res) => {
    const fromTemplate = z.object({ templateId: z.string().max(60) }).safeParse(req.body);
    const a = fromTemplate.success && Object.keys(req.body ?? {}).length === 1
      ? await reg.createFromTemplate(req.user!, fromTemplate.data.templateId)
      : await reg.create(req.user!, agentInputSchema.parse(req.body));
    await audit(req, 'agent.create', a);
    res.status(201).json(a);
  }));

  r.put('/:id', ah(async (req, res) => {
    const a = await reg.update(req.user!, req.params.id, agentInputSchema.parse(req.body));
    await audit(req, 'agent.update', a);
    res.json(a);
  }));

  r.post('/:id/duplicate', ah(async (req, res) => {
    const a = await reg.duplicate(req.user!, req.params.id);
    await audit(req, 'agent.create', a, { copiedFrom: req.params.id });
    res.status(201).json(a);
  }));

  r.post('/:id/status', ah(async (req, res) => {
    const { status } = z.object({ status: z.enum(['active', 'disabled', 'archived']) }).parse(req.body);
    const a = await reg.setStatus(req.user!, req.params.id, status);
    await audit(req, `agent.${status === 'active' ? 'enable' : status === 'disabled' ? 'disable' : 'archive'}`, a);
    res.json(a);
  }));

  r.delete('/:id', ah(async (req, res) => {
    const a = await reg.remove(req.user!, req.params.id);
    await audit(req, 'agent.delete', a);
    res.status(204).end();
  }));

  return r;
}
