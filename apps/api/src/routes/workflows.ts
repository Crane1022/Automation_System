import { Router, type Request } from 'express';
import type { AppUser, Item, Workflow, WorkflowDefinition, WorkflowVersion } from '@widebed/shared';
import {
  canEditWorkflow,
  canPublishWorkflow,
  canRunWorkflow,
  canViewWorkflow,
  emptyDefinition,
  hasPermission,
} from '@widebed/shared';
import { validateWorkflow } from '@widebed/engine';
import type { AppContext } from '../context.js';
import { ah } from '../middleware/errors.js';
import { badRequest, forbidden, notFound, unprocessable } from '../lib/http-error.js';
import { newId, nowIso } from '../lib/ids.js';
import { createWorkflowSchema, definitionSchema, runSchema, updateWorkflowSchema } from './schemas.js';
import { convertN8n, detectFormat, exportWorkflow, importNative, ImportError, relinkCredentials, type ExportFile } from '../services/workflow-transfer.js';

const LIST_LIMIT = 500;

/** Event names that a published version listens to (stored on the workflow for fast lookup). */
export function eventNamesOf(version: Pick<WorkflowVersion, 'nodes'>): string[] {
  return [...new Set(version.nodes.filter((n) => n.type === 'trigger.event' && !n.disabled).map((n) => String(n.config.eventName ?? '')).filter(Boolean))];
}

export function payloadToItems(payload: unknown): Item[] | undefined {
  if (payload === undefined || payload === null) return undefined;
  const list = Array.isArray(payload) ? payload : [payload];
  return list.map((v) => ({ json: v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v } }));
}

export function workflowsRouter(ctx: AppContext) {
  const r = Router();
  const { repos } = ctx;

  async function load(req: Request, check: 'view' | 'edit' | 'run' | 'publish' = 'view'): Promise<Workflow> {
    const wf = await repos.workflows.get(req.params.id);
    const user = req.user!;
    if (!wf || !canViewWorkflow(user, wf)) throw notFound('Workflow not found');
    const ok =
      check === 'view' ? true
      : check === 'edit' ? canEditWorkflow(user, wf)
      : check === 'run' ? canRunWorkflow(user, wf)
      : canPublishWorkflow(user, wf);
    if (!ok) throw forbidden();
    return wf;
  }

  /**
   * Rules that depend on who is saving:
   *  - Code nodes may only be added or changed by users allowed to write custom code.
   *  - Connections (credentials) must be ones this user is allowed to see.
   */
  async function checkDefinitionRights(user: AppUser, next: WorkflowDefinition, previous: WorkflowDefinition | null) {
    if (!hasPermission(user, 'node.createCustom')) {
      const before = new Map((previous?.nodes ?? []).filter((n) => n.type === 'data.code').map((n) => [n.id, JSON.stringify(n.config)]));
      const changed = next.nodes.some((n) => n.type === 'data.code' && before.get(n.id) !== JSON.stringify(n.config));
      if (changed) throw forbidden('Only IT Admins can add or change Code nodes');
    }
    const ids = [...new Set(next.nodes.map((n) => n.credentialId).filter((x): x is string => !!x))];
    for (const id of ids) {
      const c = await repos.credentials.get(id);
      if (!c || !ctx.credentials.visibleTo(user, c)) throw forbidden('A node uses a connection you do not have access to');
    }
  }

  // List workflows visible to the current user.
  r.get('/', ah(async (req, res) => {
    const user = req.user!;
    let list: Workflow[];
    if (hasPermission(user, 'workflow.viewAll')) {
      list = await repos.workflows.listAll(LIST_LIMIT);
    } else {
      const parts = await Promise.all([
        repos.workflows.listByOwner(user.uid, LIST_LIMIT),
        repos.workflows.listSharedWith(user.uid, LIST_LIMIT),
        user.department && hasPermission(user, 'workflow.manageDepartment')
          ? repos.workflows.listByDepartment(user.department, LIST_LIMIT)
          : Promise.resolve([]),
      ]);
      const map = new Map<string, Workflow>();
      parts.flat().forEach((w) => map.set(w.workflowId, w));
      list = [...map.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    const search = String(req.query.search ?? '').trim().toLowerCase();
    const folderId = req.query.folderId as string | undefined;
    const tag = req.query.tag as string | undefined;
    const status = req.query.status as string | undefined;
    list = list.filter(
      (w) =>
        (!search || w.name.toLowerCase().includes(search) || w.description.toLowerCase().includes(search) || w.tags.some((t) => t.toLowerCase().includes(search))) &&
        (folderId === undefined || (folderId === 'none' ? !w.folderId : w.folderId === folderId)) &&
        (!tag || w.tags.includes(tag)) &&
        (!status || w.status === status),
    );
    // The list view does not need full definitions.
    res.json({
      items: list.map(({ draftDefinition, ...rest }) => ({ ...rest, nodeCount: draftDefinition.nodes.length, nodeTypes: [...new Set(draftDefinition.nodes.map((n) => n.type))] })),
    });
  }));

  r.post('/', ah(async (req, res) => {
    const user = req.user!;
    if (!hasPermission(user, 'workflow.create')) throw forbidden();
    const body = createWorkflowSchema.parse(req.body);
    // Department managers may only create workflows for their own department.
    const department = hasPermission(user, 'workflow.manageAll') ? body.department : user.department;
    const now = nowIso();
    const wf: Workflow = {
      workflowId: newId('wf'),
      name: body.name,
      description: body.description,
      folderId: body.folderId,
      ownerId: user.uid,
      department,
      status: 'inactive',
      tags: body.tags,
      sharedWith: [],
      draftDefinition: emptyDefinition(),
      publishedVersion: null,
      publishedVersionId: null,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
    };
    await repos.workflows.create(wf);
    await ctx.audit({ actorId: user.uid, action: 'workflow.create', resourceType: 'workflow', resourceId: wf.workflowId, metadata: { name: wf.name } });
    res.status(201).json(wf);
  }));

  /**
   * POST /api/workflows/import  { file: <parsed JSON>, folderId?, department? }
   * Accepts a Widebed export or an n8n workflow. Always creates a NEW inactive workflow
   * with the content as its draft, and returns a report of what was converted.
   */
  r.post('/import', ah(async (req, res) => {
    const user = req.user!;
    if (!hasPermission(user, 'workflow.create')) throw forbidden();
    const file = req.body?.file;
    let result;
    try {
      const format = detectFormat(file);
      result = format === 'widebed' ? importNative(file as ExportFile) : convertN8n(file);
    } catch (err) {
      if (err instanceof ImportError) throw badRequest(err.message);
      throw badRequest(`Could not read the file: ${(err as Error).message}`);
    }
    const definition = definitionSchema.parse(result.definition);
    const visible = await ctx.credentials.listVisible(user);
    const refs = detectFormat(file) === 'widebed' ? ((file as ExportFile).credentials ?? []) : [];
    relinkCredentials(definition, refs, visible, result.report, (type) => ctx.registry.get(type)?.descriptor.credentialProvider);
    // Templates: when there is exactly one usable connection of the right kind, pick it for the user.
    if (req.body.autoConnect === true) {
      for (const node of definition.nodes) {
        const provider = ctx.registry.get(node.type)?.descriptor.credentialProvider;
        if (!provider || node.credentialId) continue;
        const options = visible.filter((c) => c.provider === provider && c.status !== 'error');
        if (options.length === 1) {
          node.credentialId = options[0]!.credentialId;
          result.report.needsCredential = result.report.needsCredential.filter((x) => x !== node.name);
        }
      }
    }
    await checkDefinitionRights(user, definition, null);

    const now = nowIso();
    const wf: Workflow = {
      workflowId: newId('wf'),
      name: typeof req.body.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 120) : result.name,
      description: result.description,
      folderId: typeof req.body.folderId === 'string' ? req.body.folderId : null,
      ownerId: user.uid,
      department: hasPermission(user, 'workflow.manageAll') ? (req.body.department ?? null) : user.department,
      status: 'inactive',
      tags: [...new Set(result.tags)].slice(0, 20),
      sharedWith: [],
      draftDefinition: definition,
      publishedVersion: null,
      publishedVersionId: null,
      eventTriggers: [],
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
    };
    await repos.workflows.create(wf);
    await ctx.audit({ actorId: user.uid, action: 'workflow.import', resourceType: 'workflow', resourceId: wf.workflowId, metadata: { source: result.report.source, nodes: definition.nodes.length, unsupported: result.report.unsupported.length } });
    res.status(201).json({ workflow: { workflowId: wf.workflowId, name: wf.name }, report: result.report, issues: validateWorkflow(definition, ctx.registry) });
  }));

  // GET /api/workflows/:id/export — downloads the draft as a portable JSON file (no secrets).
  r.get('/:id/export', ah(async (req, res) => {
    const wf = await load(req);
    const file = exportWorkflow(wf, await repos.credentials.list(500));
    const slug = wf.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'workflow';
    await ctx.audit({ actorId: req.user!.uid, action: 'workflow.export', resourceType: 'workflow', resourceId: wf.workflowId });
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.widebed.json"`);
    res.json(file);
  }));

  r.get('/:id', ah(async (req, res) => {
    const wf = await load(req);
    res.json({ ...wf, permissions: { edit: canEditWorkflow(req.user!, wf), run: canRunWorkflow(req.user!, wf), publish: canPublishWorkflow(req.user!, wf) } });
  }));

  r.patch('/:id', ah(async (req, res) => {
    const wf = await load(req, 'edit');
    const patch = updateWorkflowSchema.parse(req.body);
    if (patch.department !== undefined && !hasPermission(req.user!, 'workflow.manageAll')) {
      throw forbidden('Only administrators can move workflows between departments');
    }
    if (patch.sharedWith) {
      // Keep only real, active people (and never the owner).
      const active = new Set((await repos.users.list(500)).filter((u) => u.status === 'active').map((u) => u.uid));
      const unknown = patch.sharedWith.filter((uid) => !active.has(uid));
      if (unknown.length) throw badRequest('Some of the people picked no longer have access');
      patch.sharedWith = [...new Set(patch.sharedWith)].filter((uid) => uid !== wf.ownerId);
      const added = patch.sharedWith.filter((uid) => !wf.sharedWith.includes(uid));
      const removed = wf.sharedWith.filter((uid) => !patch.sharedWith!.includes(uid));
      if (added.length || removed.length) {
        await ctx.audit({ actorId: req.user!.uid, action: 'workflow.share', resourceType: 'workflow', resourceId: wf.workflowId, metadata: { added, removed } });
      }
    }
    await repos.workflows.update(wf.workflowId, { ...patch, updatedAt: nowIso() });
    await ctx.audit({ actorId: req.user!.uid, action: 'workflow.update', resourceType: 'workflow', resourceId: wf.workflowId, metadata: { fields: Object.keys(patch) } });
    res.json(await repos.workflows.get(wf.workflowId));
  }));

  // Save the draft. Published versions are untouched.
  r.put('/:id/draft', ah(async (req, res) => {
    const wf = await load(req, 'edit');
    const definition = definitionSchema.parse(req.body.definition);
    await checkDefinitionRights(req.user!, definition, wf.draftDefinition);
    const issues = validateWorkflow(definition, ctx.registry);
    const updatedAt = nowIso();
    await repos.workflows.update(wf.workflowId, { draftDefinition: definition, updatedAt });
    res.json({ updatedAt, issues });
  }));

  r.post('/:id/validate', ah(async (req, res) => {
    const wf = await load(req);
    const def = req.body?.definition ? definitionSchema.parse(req.body.definition) : wf.draftDefinition;
    res.json({ issues: validateWorkflow(def, ctx.registry) });
  }));

  r.post('/:id/duplicate', ah(async (req, res) => {
    const src = await load(req);
    if (!hasPermission(req.user!, 'workflow.create')) throw forbidden();
    const now = nowIso();
    const copy: Workflow = {
      ...src,
      workflowId: newId('wf'),
      name: `${src.name} (copy)`.slice(0, 120),
      ownerId: req.user!.uid,
      status: 'inactive',
      sharedWith: [],
      publishedVersion: null,
      publishedVersionId: null,
      publishedAt: null,
      eventTriggers: [],
      createdAt: now,
      updatedAt: now,
    };
    await checkDefinitionRights(req.user!, src.draftDefinition, null);
    await repos.workflows.create(copy);
    await ctx.audit({ actorId: req.user!.uid, action: 'workflow.duplicate', resourceType: 'workflow', resourceId: copy.workflowId, metadata: { from: src.workflowId } });
    res.status(201).json(copy);
  }));

  r.delete('/:id', ah(async (req, res) => {
    const wf = await load(req, 'edit');
    await ctx.scheduler.sync(wf.workflowId, null);
    await ctx.webhooks.deleteForWorkflow(wf.workflowId);
    await repos.versions.deleteByWorkflow(wf.workflowId);
    await repos.workflows.delete(wf.workflowId);
    await ctx.audit({ actorId: req.user!.uid, action: 'workflow.delete', resourceType: 'workflow', resourceId: wf.workflowId, metadata: { name: wf.name } });
    res.status(204).end();
  }));

  // Publish = freeze the current draft into an immutable version snapshot.
  r.post('/:id/publish', ah(async (req, res) => {
    const wf = await load(req, 'publish');
    const issues = validateWorkflow(wf.draftDefinition, ctx.registry);
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) throw unprocessable('Fix the workflow errors before publishing', errors);
    // Re-check rights at publish time too (the draft may have been saved by someone else).
    const live = wf.publishedVersionId ? await repos.versions.get(wf.publishedVersionId) : null;
    await checkDefinitionRights(req.user!, wf.draftDefinition, live ? { schemaVersion: 1, nodes: live.nodes, connections: live.connections } : null);
    const user = req.user!;
    const version = await repos.workflows.publish(wf.workflowId, (n, current) => ({
      versionId: `${current.workflowId}_v${n}`,
      workflowId: current.workflowId,
      versionNumber: n,
      nodes: current.draftDefinition.nodes,
      connections: current.draftDefinition.connections,
      settings: current.draftDefinition.settings ?? {},
      publishedBy: user.uid,
      publishedAt: nowIso(),
    }));
    const issuedWebhooks = await ctx.webhooks.syncForVersion(version);
    await repos.workflows.update(wf.workflowId, { eventTriggers: eventNamesOf(version) });
    if (wf.status === 'active') await ctx.scheduler.sync(wf.workflowId, version);
    await ctx.audit({ actorId: user.uid, action: 'workflow.publish', resourceType: 'workflow', resourceId: wf.workflowId, metadata: { version: version.versionNumber } });
    res.json({ version, issuedWebhooks, warnings: issues.filter((i) => i.severity === 'warning') });
  }));

  r.post('/:id/activate', ah(async (req, res) => {
    const wf = await load(req, 'publish');
    if (!wf.publishedVersionId) throw unprocessable('Publish the workflow before activating it');
    await repos.workflows.update(wf.workflowId, { status: 'active', updatedAt: nowIso() });
    await ctx.scheduler.sync(wf.workflowId, await repos.versions.get(wf.publishedVersionId));
    await ctx.audit({ actorId: req.user!.uid, action: 'workflow.activate', resourceType: 'workflow', resourceId: wf.workflowId });
    res.json({ status: 'active' });
  }));

  r.post('/:id/deactivate', ah(async (req, res) => {
    const wf = await load(req, 'publish');
    await repos.workflows.update(wf.workflowId, { status: 'inactive', updatedAt: nowIso() });
    await ctx.scheduler.sync(wf.workflowId, null);
    await ctx.audit({ actorId: req.user!.uid, action: 'workflow.deactivate', resourceType: 'workflow', resourceId: wf.workflowId });
    res.json({ status: 'inactive' });
  }));

  r.get('/:id/versions', ah(async (req, res) => {
    const wf = await load(req);
    const versions = await repos.versions.listByWorkflow(wf.workflowId, 100);
    res.json({ items: versions.map(({ nodes, connections, settings, ...meta }) => ({ ...meta, nodeCount: nodes.length })) });
  }));

  r.get('/:id/versions/:n', ah(async (req, res) => {
    const wf = await load(req);
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1) throw badRequest('Invalid version number');
    const v = await repos.versions.get(`${wf.workflowId}_v${n}`);
    if (!v) throw notFound('Version not found');
    res.json(v);
  }));

  // Restore a version into the draft (does not change what is published).
  r.post('/:id/versions/:n/restore', ah(async (req, res) => {
    const wf = await load(req, 'edit');
    const v = await repos.versions.get(`${wf.workflowId}_v${Number(req.params.n)}`);
    if (!v) throw notFound('Version not found');
    await repos.workflows.update(wf.workflowId, {
      draftDefinition: { schemaVersion: 1, nodes: v.nodes, connections: v.connections, settings: v.settings ?? {} },
      updatedAt: nowIso(),
    });
    res.json({ ok: true });
  }));

  // Run the whole workflow (draft = test run from the editor).
  r.post('/:id/run', ah(async (req, res) => {
    const body = runSchema.parse(req.body ?? {});
    const wf = await load(req, body.mode === 'draft' ? 'edit' : 'run');
    const result = await ctx.executions.start({
      workflow: wf,
      mode: body.mode,
      triggerType: 'manual',
      triggerNodeId: body.triggerNodeId,
      triggerItems: payloadToItems(body.payload),
      initiatedBy: req.user!.uid,
    });
    res.status(202).json(result);
  }));

  // Test one node: runs the draft from the trigger up to (and including) this node.
  r.post('/:id/nodes/:nodeId/test', ah(async (req, res) => {
    const wf = await load(req, 'edit');
    const body = runSchema.parse(req.body ?? {});
    if (!wf.draftDefinition.nodes.some((n) => n.id === req.params.nodeId)) throw notFound('Node not found in the saved draft. Save first.');
    const result = await ctx.executions.start({
      workflow: wf,
      mode: 'draft',
      triggerType: 'manual',
      triggerNodeId: body.triggerNodeId,
      triggerItems: payloadToItems(body.payload),
      initiatedBy: req.user!.uid,
      untilNodeId: req.params.nodeId,
    });
    res.status(202).json(result);
  }));

  r.get('/:id/webhooks', ah(async (req, res) => {
    const wf = await load(req, 'edit');
    const list = await repos.webhooks.listByWorkflow(wf.workflowId);
    // Never return token hashes or secrets.
    res.json({ items: list.map((w) => ({ webhookId: w.webhookId, nodeId: w.nodeId, status: w.status, createdAt: w.createdAt })) });
  }));

  r.post('/:id/webhooks/:nodeId/rotate', ah(async (req, res) => {
    const wf = await load(req, 'publish');
    if (!wf.publishedVersionId) throw unprocessable('Publish the workflow first');
    const version = await repos.versions.get(wf.publishedVersionId);
    if (!version?.nodes.some((n) => n.id === req.params.nodeId && n.type === 'trigger.webhook')) {
      throw notFound('No webhook trigger with this id in the published version');
    }
    const issued = await ctx.webhooks.rotate(wf.workflowId, req.params.nodeId);
    await ctx.audit({ actorId: req.user!.uid, action: 'webhook.rotate', resourceType: 'workflow', resourceId: wf.workflowId, metadata: { nodeId: req.params.nodeId } });
    res.json(issued);
  }));

  return r;
}
