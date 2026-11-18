import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ah } from '../middleware/errors.js';

const priority = z.enum(['low', 'normal', 'high']);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-31');
const scheduleBody = z.object({
  name: z.string().trim().min(1, 'Give the schedule a name').max(80),
  agentId: z.string().min(1).max(100),
  instructions: z.string().trim().min(1, 'Write what it should do each time').max(4000),
  rule: z.record(z.unknown()),
  startDate: day.nullable(),
  endDate: day.nullable(),
  priority,
  enabled: z.boolean(),
  notify: z.enum(['failures', 'always', 'off']).optional(),
});
const responsibilityBody = z.object({
  agentId: z.string().min(1).max(100),
  title: z.string().trim().min(1, 'Give the responsibility a title').max(120),
  description: z.string().max(2000).default(''),
  status: z.enum(['active', 'paused']),
  autoFollowUp: z.boolean(),
  scheduleIds: z.array(z.string().max(100)).max(20).default([]),
});

/**
 * /api/agent-tasks      — AI Staff background tasks (Task Center)
 * /api/agent-schedules  — recurring work for AI staff
 * Every check happens in AgentTaskService.
 */
export function agentTasksRouter(ctx: AppContext) {
  const r = Router();
  const svc = ctx.agentTasks;

  r.get('/', ah(async (req, res) => {
    const q = z
      .object({ agentId: z.string().max(100).optional(), status: z.string().max(20).optional(), source: z.string().max(20).optional(), scheduleId: z.string().max(100).optional(), since: z.string().max(40).optional() })
      .parse(req.query);
    res.json({ items: await svc.list(req.user!, q) });
  }));
  r.get('/:id', ah(async (req, res) => res.json(await svc.get(req.user!, req.params.id))));
  r.post('/', ah(async (req, res) => {
    const body = z.object({ agentId: z.string().min(1).max(100), instructions: z.string().trim().min(1, 'Describe the task').max(4000), title: z.string().max(100).optional(), priority: priority.optional() }).parse(req.body);
    const t = await svc.create(req.user!, body);
    await ctx.audit({ actorId: req.user!.uid, action: 'agentTask.create', resourceType: 'agentTask', resourceId: t.taskId, metadata: { agentId: t.agentId, title: t.title } });
    res.status(201).json(t);
  }));
  r.post('/:id/cancel', ah(async (req, res) => {
    await svc.cancel(req.user!, req.params.id);
    res.json({ ok: true });
  }));
  r.post('/:id/retry', ah(async (req, res) => {
    await svc.retry(req.user!, req.params.id);
    res.status(202).json({ ok: true });
  }));
  return r;
}

export function agentSchedulesRouter(ctx: AppContext) {
  const r = Router();
  const svc = ctx.agentTasks;
  const audit = (req: any, action: string, id: string, metadata: Record<string, unknown> = {}) =>
    ctx.audit({ actorId: req.user!.uid, action, resourceType: 'agentSchedule', resourceId: id, metadata });

  r.get('/', ah(async (req, res) => res.json({ items: await svc.listSchedules(req.user!, typeof req.query.agentId === 'string' ? req.query.agentId : undefined) })));
  r.post('/', ah(async (req, res) => {
    const body = scheduleBody.parse(req.body);
    const s = await svc.createSchedule(req.user!, body as any);
    await audit(req, 'agentSchedule.create', s.scheduleId, { name: s.name, agentId: s.agentId });
    res.status(201).json(s);
  }));
  r.put('/:id', ah(async (req, res) => {
    const body = scheduleBody.parse(req.body);
    const s = await svc.updateSchedule(req.user!, req.params.id, body as any);
    await audit(req, 'agentSchedule.update', s.scheduleId, { name: s.name, enabled: s.enabled });
    res.json(s);
  }));
  r.delete('/:id', ah(async (req, res) => {
    const s = await svc.deleteSchedule(req.user!, req.params.id);
    await audit(req, 'agentSchedule.delete', s.scheduleId, { name: s.name });
    res.status(204).end();
  }));
  r.post('/:id/run', ah(async (req, res) => {
    const t = await svc.runNow(req.user!, req.params.id);
    res.status(202).json(t);
  }));
  return r;
}

/** /api/agent-responsibilities — long-term duties of AI staff, with the problems they track. */
export function agentResponsibilitiesRouter(ctx: AppContext) {
  const r = Router();
  const svc = ctx.agentTasks;
  const audit = (req: any, action: string, id: string, metadata: Record<string, unknown> = {}) =>
    ctx.audit({ actorId: req.user!.uid, action, resourceType: 'agentResponsibility', resourceId: id, metadata });
  r.get('/', ah(async (req, res) => res.json({ items: await svc.listResponsibilities(req.user!) })));
  r.post('/', ah(async (req, res) => {
    const x = await svc.createResponsibility(req.user!, responsibilityBody.parse(req.body));
    await audit(req, 'agentResponsibility.create', x.responsibilityId, { title: x.title });
    res.status(201).json(x);
  }));
  r.put('/:id', ah(async (req, res) => {
    const x = await svc.updateResponsibility(req.user!, req.params.id, responsibilityBody.parse(req.body));
    await audit(req, 'agentResponsibility.update', x.responsibilityId, { title: x.title, status: x.status });
    res.json(x);
  }));
  r.delete('/:id', ah(async (req, res) => {
    const x = await svc.deleteResponsibility(req.user!, req.params.id);
    await audit(req, 'agentResponsibility.delete', x.responsibilityId, { title: x.title });
    res.status(204).end();
  }));
  r.post('/:id/issues/:key/resolve', ah(async (req, res) => {
    await svc.resolveIssue(req.user!, req.params.id, req.params.key);
    res.json({ ok: true });
  }));
  return r;
}

/** /api/notifications — the bell. */
export function notificationsRouter(ctx: AppContext) {
  const r = Router();
  const svc = ctx.notifications;
  r.get('/', ah(async (req, res) => res.json(await svc.list(req.user!))));
  r.post('/read-all', ah(async (req, res) => res.json({ marked: await svc.readAll(req.user!) })));
  r.post('/:id/read', ah(async (req, res) => {
    await svc.read(req.user!, req.params.id);
    res.json({ ok: true });
  }));
  r.get('/prefs', ah(async (req, res) => res.json(await svc.prefs(req.user!.uid))));
  r.put('/prefs', ah(async (req, res) => {
    const body = z.object({ taskCompleted: z.boolean(), taskFailed: z.boolean(), issues: z.boolean(), approvals: z.boolean().default(true), browser: z.boolean() }).parse(req.body);
    res.json(await svc.savePrefs(req.user!.uid, body));
  }));
  return r;
}

/** /api/agent-projects — work a manager split between AI staff (Collaboration page). */
export function agentProjectsRouter(ctx: AppContext) {
  const r = Router();
  r.get('/', ah(async (req, res) => res.json({ items: await ctx.agentTasks.listProjects(req.user!) })));
  return r;
}
