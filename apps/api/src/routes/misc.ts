import { Router } from 'express';
import type { AppUser } from '@widebed/shared';
import { describeSchedule, hasPermission } from '@widebed/shared';
import { PLANNED_NODES } from '@widebed/nodes';
import type { AppContext } from '../context.js';
import { ah } from '../middleware/errors.js';
import { requirePermission } from '../middleware/auth.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/http-error.js';
import { newId, nowIso } from '../lib/ids.js';
import { dailyQuerySchema, folderSchema, inviteUserSchema, statsQuerySchema, systemSettingsSchema, updateUserSchema } from './schemas.js';
import { SystemService, validTimeZone } from '../services/system-service.js';
import { exportWorkflow } from '../services/workflow-transfer.js';
import { BACKUP_FORMAT, type PersonSummary } from '@widebed/shared';
import { scopeFilter } from './executions.js';
import { canViewWorkflow } from '@widebed/shared';
import { nextRun, scheduleNodes } from '../services/scheduler.js';

export function meRouter(ctx: AppContext) {
  const r = Router();
  r.get('/', (req, res) => res.json(req.user));
  // Called once after sign-in to record the login time.
  r.post('/session', ah(async (req, res) => {
    await ctx.repos.users.update(req.user!.uid, { lastLoginAt: nowIso() });
    await ctx.audit({ actorId: req.user!.uid, action: 'auth.login', resourceType: 'user', resourceId: req.user!.uid });
    res.json({ ok: true });
  }));
  return r;
}

export function usersRouter(ctx: AppContext, invalidate: (uid: string) => void) {
  const r = Router();
  r.use(requirePermission('user.manage'));
  r.get('/', ah(async (_req, res) => {
    res.json({ items: await ctx.repos.users.list(500) });
  }));
  /**
   * Invite: an admin creates the account. The person is active immediately with the
   * chosen role; the web app then emails them a link to set their own password.
   */
  r.post('/invite', ah(async (req, res) => {
    if (!ctx.directory) throw new HttpError(501, 'Inviting users is not available in this environment');
    const body = inviteUserSchema.parse(req.body);
    const { uid, existed } = await ctx.directory.ensureAccount(body.email, body.name);
    if (await ctx.repos.users.get(uid)) throw conflict('This person already has access. Change their role in the list instead.');
    const user: AppUser = {
      uid,
      name: body.name,
      email: body.email,
      role: body.role,
      department: body.department,
      status: 'active',
      createdAt: nowIso(),
      lastLoginAt: null,
    };
    await ctx.repos.users.create(user);
    await ctx.audit({ actorId: req.user!.uid, action: 'user.invite', resourceType: 'user', resourceId: uid, metadata: { email: body.email, role: body.role, existingAccount: existed } });
    res.status(201).json(user);
  }));

  r.patch('/:uid', ah(async (req, res) => {
    const patch = updateUserSchema.parse(req.body);
    const target = await ctx.repos.users.get(req.params.uid);
    if (!target) throw notFound('User not found');
    if (target.uid === req.user!.uid && (patch.role && patch.role !== target.role || patch.status && patch.status !== 'active')) {
      throw badRequest('You cannot change your own role or disable yourself');
    }
    await ctx.repos.users.update(target.uid, patch as Partial<AppUser>);
    // Also block / unblock sign-in in Firebase Authentication itself.
    if (patch.status && ctx.directory) await ctx.directory.setDisabled(target.uid, patch.status === 'disabled');
    invalidate(target.uid);
    await ctx.audit({ actorId: req.user!.uid, action: 'user.update', resourceType: 'user', resourceId: target.uid, metadata: patch });
    res.json(await ctx.repos.users.get(target.uid));
  }));
  return r;
}

/**
 * GET /api/people — active people, name + email + department only.
 * Lets workflow creators pick who to share a workflow with (the full user list stays admin-only).
 */
export function peopleRouter(ctx: AppContext) {
  const r = Router();
  r.get('/', ah(async (req, res) => {
    if (!hasPermission(req.user!, 'workflow.create')) throw forbidden();
    const items: PersonSummary[] = (await ctx.repos.users.list(500))
      .filter((u) => u.status === 'active')
      .map((u) => ({ uid: u.uid, name: u.name, email: u.email, department: u.department }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ items });
  }));
  return r;
}

export function foldersRouter(ctx: AppContext) {
  const r = Router();
  r.get('/', ah(async (req, res) => {
    const user = req.user!;
    const all = await ctx.repos.folders.list(500);
    const visible = hasPermission(user, 'workflow.viewAll') ? all : all.filter((f) => f.ownerId === user.uid || (user.department && f.department === user.department));
    res.json({ items: visible });
  }));
  r.post('/', ah(async (req, res) => {
    if (!hasPermission(req.user!, 'workflow.create')) throw forbidden();
    const body = folderSchema.parse(req.body);
    const folder = {
      folderId: newId('fld'),
      name: body.name,
      ownerId: req.user!.uid,
      department: hasPermission(req.user!, 'workflow.manageAll') ? body.department : req.user!.department,
      createdAt: nowIso(),
    };
    await ctx.repos.folders.create(folder);
    res.status(201).json(folder);
  }));
  r.patch('/:id', ah(async (req, res) => {
    const f = await ctx.repos.folders.get(req.params.id);
    if (!f) throw notFound();
    if (f.ownerId !== req.user!.uid && !hasPermission(req.user!, 'workflow.manageAll')) throw forbidden();
    const { name } = folderSchema.pick({ name: true }).parse(req.body);
    await ctx.repos.folders.update(f.folderId, { name });
    res.json({ ...f, name });
  }));
  r.delete('/:id', ah(async (req, res) => {
    const f = await ctx.repos.folders.get(req.params.id);
    if (!f) throw notFound();
    if (f.ownerId !== req.user!.uid && !hasPermission(req.user!, 'workflow.manageAll')) throw forbidden();
    // Move workflows out of the folder rather than deleting them.
    const wfs = (await ctx.repos.workflows.listAll(1000)).filter((w) => w.folderId === f.folderId);
    for (const w of wfs) await ctx.repos.workflows.update(w.workflowId, { folderId: null });
    await ctx.repos.folders.delete(f.folderId);
    res.status(204).end();
  }));
  return r;
}

export function nodeTypesRouter(ctx: AppContext) {
  const r = Router();
  r.get('/', (_req, res) => res.json({ nodes: ctx.registry.descriptors(), planned: PLANNED_NODES }));
  return r;
}

export function dashboardRouter(ctx: AppContext) {
  const r = Router();
  r.get('/stats', ah(async (req, res) => {
    const user = req.user!;
    const q = statsQuerySchema.parse(req.query);
    const range = { from: q.from ?? new Date(Date.now() - 30 * 86400_000).toISOString(), to: q.to };
    const scoped = (extra: object = {}) => scopeFilter(user, { ...range, ...extra });
    const ex = ctx.repos.executions;
    const seeAllWorkflows = hasPermission(user, 'workflow.viewAll');
    const [total, success, failed, running, queued, wfTotal, wfActive, recent] = await Promise.all([
      ex.count(scoped()),
      ex.count(scoped({ status: 'success' })),
      ex.count(scoped({ status: 'failed' })),
      ex.count(scopeFilter(user, { status: 'running' })),
      ex.count(scopeFilter(user, { status: 'queued' })),
      seeAllWorkflows ? ctx.repos.workflows.count({}) : Promise.resolve(null),
      seeAllWorkflows ? ctx.repos.workflows.count({ status: 'active' }) : Promise.resolve(null),
      ex.list(scopeFilter(user, {}), 10),
    ]);
    const finished = success + failed;
    res.json({
      range,
      workflows: wfTotal === null ? null : { total: wfTotal, active: wfActive, inactive: wfTotal - (wfActive ?? 0) },
      executions: { total, success, failed, successRate: finished ? Math.round((success / finished) * 1000) / 10 : null },
      running: { running, queued },
      recent: recent.items,
    });
  }));
  /** GET /api/dashboard/daily?days=14&tz=Asia/Kuala_Lumpur — runs per day for the Overview chart. */
  r.get('/daily', ah(async (req, res) => {
    const q = dailyQuerySchema.parse(req.query);
    const tz = validTimeZone(q.tz);
    const from = new Date(Date.now() - (q.days + 1) * 86400_000).toISOString();
    const rows: { createdAt: string; status: any }[] = [];
    let cursor: string | undefined;
    // Up to 5 000 runs is plenty for a chart; stop early after that.
    for (let i = 0; i < 25; i++) {
      const page = await ctx.repos.executions.list(scopeFilter(req.user!, { from }), 200, cursor);
      rows.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    res.json({ timeZone: tz, days: SystemService.bucketByDay(rows, q.days, tz) });
  }));
  return r;
}

export function systemRouter(ctx: AppContext) {
  const r = Router();
  r.get('/health', ah(async (_req, res) => {
    const t0 = Date.now();
    let firestore: { ok: boolean; latencyMs?: number; error?: string };
    try {
      await ctx.repos.ping();
      firestore = { ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      firestore = { ok: false, error: (err as Error).message };
    }
    const mem = process.memoryUsage();
    const queue = await ctx.executions.queue.stats().then((q) => ({ ok: true, mode: ctx.executions.queue.mode, ...q })).catch((e) => ({ ok: false, mode: ctx.executions.queue.mode, error: (e as Error).message }));
    res.json({
      status: firestore.ok && queue.ok ? 'ok' : 'degraded',
      uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
      firestore,
      queue,
      scheduler: ctx.scheduler.mode,
      memoryMb: Math.round(mem.rss / 1024 / 1024),
      nodeVersion: process.version,
    });
  }));
  r.get('/audit-logs', requirePermission('audit.view'), ah(async (req, res) => {
    const page = await ctx.repos.audit.list(50, req.query.cursor as string | undefined);
    // Add the person's name so the page can show "Ivan published …" instead of an id.
    const users = new Map((await ctx.repos.users.list(500)).map((u) => [u.uid, u]));
    res.json({
      ...page,
      items: page.items.map((l) => ({ ...l, actorName: l.actorId ? users.get(l.actorId)?.name ?? null : null, actorEmail: l.actorId ? users.get(l.actorId)?.email ?? null : null })),
    });
  }));

  /* ------------------------------------------------ admin system settings */
  r.get('/settings', requirePermission('settings.manage'), ah(async (_req, res) => {
    res.json(await ctx.system.settings());
  }));
  r.put('/settings', requirePermission('settings.manage'), ah(async (req, res) => {
    const body = systemSettingsSchema.parse(req.body);
    if (body.alerts.credentialId) {
      const c = await ctx.repos.credentials.get(body.alerts.credentialId);
      if (!c || c.provider !== 'google_oauth') throw badRequest('Pick a Google connection to send alerts from');
    }
    if (body.alerts.enabled && (!body.alerts.credentialId || !body.alerts.emails.length)) {
      throw badRequest('To turn alerts on, pick a Google connection and add at least one email');
    }
    const saved = await ctx.system.save({ ...body, ai: body.ai ?? (await ctx.system.settings()).ai });
    await ctx.audit({ actorId: req.user!.uid, action: 'settings.update', resourceType: 'settings', resourceId: 'system', metadata: { alertsEnabled: body.alerts.enabled, recipients: body.alerts.emails.length } });
    res.json(saved);
  }));
  r.post('/alerts/test', requirePermission('settings.manage'), ah(async (_req, res) => {
    try {
      await ctx.system.sendTest();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw badRequest((err as Error).message);
    }
    res.json({ ok: true });
  }));

  /**
   * GET /api/system/backup — every workflow (draft + settings, no secrets) in one file.
   * Restore = import each workflow again (the web app does this one by one).
   */
  r.get('/backup', requirePermission('settings.manage'), ah(async (req, res) => {
    const creds = await ctx.repos.credentials.list(500);
    const folders = new Map((await ctx.repos.folders.list(500)).map((f) => [f.folderId, f.name]));
    const workflows = (await ctx.repos.workflows.listAll(2000)).map((wf) => ({
      ...exportWorkflow(wf, creds),
      backup: { workflowId: wf.workflowId, status: wf.status, department: wf.department, folder: wf.folderId ? folders.get(wf.folderId) ?? null : null, publishedVersion: wf.publishedVersion },
    }));
    await ctx.audit({ actorId: req.user!.uid, action: 'system.backup', resourceType: 'settings', resourceId: 'backup', metadata: { workflows: workflows.length } });
    res.setHeader('Content-Disposition', `attachment; filename="widebed-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), workflows });
  }));
  return r;
}

/** GET /api/schedules — active schedule triggers the user can see, with their next run time. */
export function schedulesRouter(ctx: AppContext) {
  const r = Router();
  r.get('/', ah(async (req, res) => {
    const user = req.user!;
    const items = [];
    for (const wf of await ctx.repos.workflows.listActive(1000)) {
      if (!canViewWorkflow(user, wf) || !wf.publishedVersionId) continue;
      const version = await ctx.repos.versions.get(wf.publishedVersionId);
      for (const { node, cfg } of scheduleNodes(version)) {
        items.push({
          workflowId: wf.workflowId,
          workflowName: wf.name,
          department: wf.department,
          nodeId: node.id,
          nodeName: node.name,
          mode: cfg.mode,
          description: describeSchedule(cfg),
          timezone: cfg.timezone,
          nextRunAt: ((at) => (at === null ? null : new Date(at).toISOString()))(nextRun(cfg, Date.now())),
        });
      }
    }
    items.sort((a, b) => (a.nextRunAt ?? '9999').localeCompare(b.nextRunAt ?? '9999'));
    res.json({ items, mode: ctx.scheduler.mode });
  }));
  return r;
}
