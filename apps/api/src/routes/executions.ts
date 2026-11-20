import { Router, type Request } from 'express';
import type { AppUser, Execution, ExecutionEvent } from '@widebed/shared';
import { TERMINAL_STATUSES, canRunWorkflow, hasPermission } from '@widebed/shared';
import type { AppContext } from '../context.js';
import { ah } from '../middleware/errors.js';
import { forbidden, notFound } from '../lib/http-error.js';
import type { ExecutionFilter, StoredExecution } from '../repositories/types.js';
import { executionQuerySchema } from './schemas.js';

export function canViewExecution(user: AppUser, e: Pick<Execution, 'department' | 'initiatedBy'>) {
  if (hasPermission(user, 'execution.viewAll')) return true;
  if (hasPermission(user, 'execution.viewDepartment') && user.department && e.department === user.department) return true;
  return e.initiatedBy === user.uid;
}

/** Narrows a filter to what the user is allowed to see. */
export function scopeFilter(user: AppUser, f: ExecutionFilter): ExecutionFilter {
  if (hasPermission(user, 'execution.viewAll')) return f;
  if (hasPermission(user, 'execution.viewDepartment') && user.department) return { ...f, department: user.department };
  return { ...f, initiatedBy: user.uid };
}

const publicExec = ({ triggerItems, triggerNodeId, definitionJson, untilNodeId, webhookResponseJson, ...rest }: StoredExecution) => rest;

export function executionsRouter(ctx: AppContext) {
  const r = Router();
  const { repos } = ctx;

  async function load(req: Request) {
    const e = await repos.executions.get(req.params.id);
    if (!e || !canViewExecution(req.user!, e)) throw notFound('Execution not found');
    return e;
  }

  r.get('/', ah(async (req, res) => {
    const q = executionQuerySchema.parse(req.query);
    const { cursor, limit, ...filter } = q;
    const page = await repos.executions.list(scopeFilter(req.user!, filter), limit, cursor);
    res.json(page);
  }));

  r.get('/:id', ah(async (req, res) => {
    const e = await load(req);
    const steps = await repos.executions.listSteps(e.executionId);
    res.json({ ...publicExec(e), steps });
  }));

  /**
   * Server-Sent Events stream for one execution.
   * The client uses fetch() with the Authorization header (not EventSource),
   * so tokens never appear in URLs or access logs.
   */
  r.get('/:id/stream', ah(async (req, res) => {
    const e = await load(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: ExecutionEvent | { type: 'snapshot'; execution: unknown; steps: unknown }) =>
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

    // Subscribe first, then send the snapshot, so no event falls in between.
    const unsubscribe = ctx.bus.subscribe(e.executionId, (ev) => {
      send(ev);
      if (ev.type === 'execution.status' && TERMINAL_STATUSES.includes(ev.status)) close();
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    }
    req.on('close', close);

    const fresh = (await repos.executions.get(e.executionId))!;
    send({ type: 'snapshot', execution: publicExec(fresh), steps: await repos.executions.listSteps(e.executionId) });
    if (TERMINAL_STATUSES.includes(fresh.status)) close();
  }));

  r.post('/:id/cancel', ah(async (req, res) => {
    const e = await load(req);
    const user = req.user!;
    if (e.initiatedBy !== user.uid && !hasPermission(user, 'execution.viewDepartment')) throw forbidden();
    const result = await ctx.executions.cancel(e.executionId);
    await ctx.audit({ actorId: user.uid, action: 'execution.cancel', resourceType: 'execution', resourceId: e.executionId });
    res.json({ ok: true, ...result });
  }));

  r.post('/:id/retry', ah(async (req, res) => {
    const e = await load(req);
    const wf = await repos.workflows.get(e.workflowId);
    if (!wf || !canRunWorkflow(req.user!, wf)) throw forbidden();
    const result = await ctx.executions.retry(e.executionId, req.user!.uid);
    await ctx.audit({ actorId: req.user!.uid, action: 'execution.retry', resourceType: 'execution', resourceId: e.executionId, metadata: { newExecutionId: result.executionId } });
    res.status(202).json(result);
  }));

  return r;
}
