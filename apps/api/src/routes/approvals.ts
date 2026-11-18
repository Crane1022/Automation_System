import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ah } from '../middleware/errors.js';
import { forbidden } from '../lib/http-error.js';

/** /api/approvals — the Approval Center. All rules live in ApprovalService. */
export function approvalsRouter(ctx: AppContext) {
  const r = Router();
  const svc = ctx.approvals;
  const audit = (req: any, action: string, id: string, metadata: Record<string, unknown>) =>
    ctx.audit({ actorId: req.user!.uid, action, resourceType: 'approval', resourceId: id, metadata });

  r.get('/', ah(async (req, res) => {
    const status = req.query.status === 'history' ? 'history' : req.query.status === 'pending' ? 'pending' : undefined;
    res.json({ items: await svc.list(req.user!, status) });
  }));

  /** Admin policy: how low-risk actions are handled, and how long requests wait. */
  r.get('/policy', ah(async (_req, res) => res.json((await ctx.system.settings()).ai)));
  r.put('/policy', ah(async (req, res) => {
    if (!ctx.assistant.agents.canManage(req.user!)) throw forbidden('Only Admins can change the approval policy');
    const body = z.object({ lowRiskPolicy: z.enum(['auto', 'auto_in_chat', 'ask']), approvalHours: z.number().int().min(1).max(168) }).parse(req.body);
    const current = await ctx.system.settings();
    await ctx.system.save({ ...current, ai: body });
    await audit(req, 'approval.policy', 'policy', body);
    res.json(body);
  }));

  r.post('/:id/decide', ah(async (req, res) => {
    const body = z.object({ approve: z.boolean(), note: z.string().max(500).optional(), confirmWord: z.string().max(20).optional() }).parse(req.body);
    const a = await svc.decide(req.user!, req.params.id, body);
    await audit(req, body.approve ? 'approval.approve' : 'approval.reject', a.approvalId, { agentId: a.agentId, tool: a.tool, level: a.level, inputHash: a.inputHash, note: a.note });
    res.json(a);
  }));

  r.post('/:id/edit', ah(async (req, res) => {
    const body = z.object({ input: z.record(z.unknown()), note: z.string().max(500).optional() }).parse(req.body);
    const a = await svc.edit(req.user!, req.params.id, body.input, body.note);
    await audit(req, 'approval.edit', a.approvalId, { editedFrom: a.editedFrom, agentId: a.agentId, tool: a.tool, level: a.level });
    res.status(201).json(a);
  }));

  return r;
}
