import { z } from 'zod';
import { Router } from 'express';
import type { AppUser, CustomStep } from '@widebed/shared';
import { CUSTOM_STEP_BLOCKED_TYPES, credentialRefs, customStepVisible, hasPermission } from '@widebed/shared';
import type { AppContext } from '../context.js';
import { ah } from '../middleware/errors.js';
import { badRequest, forbidden, notFound, unprocessable } from '../lib/http-error.js';
import { newId, nowIso } from '../lib/ids.js';

/**
 * Saved team steps ("My team's steps").
 *
 *  - Anyone who builds workflows can save a step for their team.
 *  - Admins (who see every workflow) can also share a step with the whole company.
 *  - The person who saved it, Admins, and the team's manager can change or delete it.
 *  - Connections inside a saved step must be ones the person saving it may use;
 *    at run time the workflow's team must still be allowed to use them.
 */

const fieldSchema = z.object({
  key: z.string().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  help: z.string().max(300).optional(),
});

const createSchema = z.object({
  name: z.string().trim().min(1, 'give the step a name').max(60),
  description: z.string().max(300).default(''),
  icon: z.string().max(40).optional(),
  baseType: z.string().min(1),
  config: z.record(z.unknown()),
  credentialId: z.string().max(100).nullish(),
  fields: z.array(fieldSchema).max(30).default([]),
  shareWith: z.enum(['team', 'everyone']).default('team'),
});

const updateSchema = createSchema.partial().omit({ baseType: true });

export function seesAllSteps(user: AppUser) {
  return hasPermission(user, 'workflow.viewAll');
}

export function canUseStep(user: AppUser, step: CustomStep) {
  return customStepVisible(step, user.department ?? null, seesAllSteps(user));
}

function canManageStep(user: AppUser, step: CustomStep) {
  if (step.createdBy === user.uid) return true;
  if (hasPermission(user, 'workflow.manageAll')) return true;
  return hasPermission(user, 'workflow.manageDepartment') && !!user.department && step.department === user.department;
}

export function customStepsRouter(ctx: AppContext) {
  const r = Router();
  const { repos, registry } = ctx;

  /** Checks the saved settings: a step type that can be saved, settings that are valid, connections the user may use. */
  async function checkStep(user: AppUser, baseType: string, config: Record<string, unknown>, fields: { key: string }[], credentialId?: string | null) {
    const impl = registry.get(baseType);
    if (!impl || impl.descriptor.isTrigger || CUSTOM_STEP_BLOCKED_TYPES.includes(baseType)) {
      throw badRequest(impl?.descriptor.isTrigger ? 'Triggers cannot be saved as a team step' : 'This kind of step cannot be saved as a team step');
    }
    if (impl.descriptor.dynamicOutputs || impl.descriptor.outputs.length !== 1) {
      throw badRequest(`“${impl.descriptor.displayName}” has more than one output, so it cannot be saved as a team step yet`);
    }
    const keys = new Set(impl.descriptor.fields.map((f) => f.key));
    const unknown = fields.find((f) => !keys.has(f.key));
    if (unknown) throw badRequest(`“${impl.descriptor.displayName}” has no box called “${unknown.key}”`);
    if (new Set(fields.map((f) => f.key)).size !== fields.length) throw badRequest('Each box can be chosen only once');
    const parsed = impl.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'settings'} — ${i.message}`).join('; ');
      throw unprocessable(`The step's settings are not complete: ${msg}`);
    }
    const ids = credentialRefs({ credentialId, config }, impl.descriptor);
    for (const id of ids) {
      const c = await repos.credentials.get(id);
      if (!c || !ctx.credentials.visibleTo(user, c)) throw forbidden('The step uses a connection you do not have access to');
    }
    return impl;
  }

  r.get('/', ah(async (req, res) => {
    const user = req.user!;
    const items = (await repos.customSteps.list())
      .filter((s) => canUseStep(user, s))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ ...s, canManage: canManageStep(user, s) }));
    res.json({ items });
  }));

  r.post('/', ah(async (req, res) => {
    const user = req.user!;
    if (!hasPermission(user, 'workflow.create')) throw forbidden('Only people who build workflows can save team steps');
    const body = createSchema.parse(req.body);
    if (body.shareWith === 'everyone' && !seesAllSteps(user)) throw forbidden('Only Admins can share a step with everyone');
    const impl = await checkStep(user, body.baseType, body.config, body.fields, body.credentialId);
    const now = nowIso();
    const step: CustomStep = {
      stepId: newId('step'),
      name: body.name,
      description: body.description,
      icon: body.icon || impl.descriptor.icon,
      baseType: body.baseType,
      baseConfig: body.config,
      credentialId: body.credentialId ?? null,
      fields: body.fields,
      department: body.shareWith === 'everyone' || !user.department ? null : user.department,
      createdBy: user.uid,
      createdByName: user.name,
      createdAt: now,
      updatedAt: now,
    };
    await repos.customSteps.create(step);
    await ctx.audit({ actorId: user.uid, action: 'customStep.create', resourceType: 'customStep', resourceId: step.stepId, metadata: { name: step.name, baseType: step.baseType, department: step.department } });
    res.status(201).json({ ...step, canManage: true });
  }));

  r.patch('/:id', ah(async (req, res) => {
    const user = req.user!;
    const step = await repos.customSteps.get(req.params.id);
    if (!step || !canUseStep(user, step)) throw notFound('Saved step not found');
    if (!canManageStep(user, step)) throw forbidden('Only the person who saved this step, their manager or an Admin can change it');
    const body = updateSchema.parse(req.body);
    if (body.shareWith === 'everyone' && !seesAllSteps(user)) throw forbidden('Only Admins can share a step with everyone');
    const config = body.config ?? step.baseConfig;
    const fields = body.fields ?? step.fields;
    const credentialId = body.credentialId !== undefined ? body.credentialId ?? null : step.credentialId ?? null;
    if (body.config || body.fields || body.credentialId !== undefined) await checkStep(user, step.baseType, config, fields, credentialId);
    const patch: Partial<CustomStep> = {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.icon && { icon: body.icon }),
      ...(body.config && { baseConfig: config }),
      ...(body.fields && { fields }),
      ...(body.credentialId !== undefined && { credentialId }),
      ...(body.shareWith && { department: body.shareWith === 'everyone' ? null : (step.department ?? user.department ?? null) }),
      updatedAt: nowIso(),
    };
    await repos.customSteps.update(step.stepId, patch);
    await ctx.audit({ actorId: user.uid, action: 'customStep.update', resourceType: 'customStep', resourceId: step.stepId, metadata: { fields: Object.keys(patch) } });
    res.json({ ...step, ...patch, canManage: true });
  }));

  r.delete('/:id', ah(async (req, res) => {
    const user = req.user!;
    const step = await repos.customSteps.get(req.params.id);
    if (!step || !canUseStep(user, step)) throw notFound('Saved step not found');
    if (!canManageStep(user, step)) throw forbidden('Only the person who saved this step, their manager or an Admin can delete it');
    await repos.customSteps.delete(step.stepId);
    await ctx.audit({ actorId: user.uid, action: 'customStep.delete', resourceType: 'customStep', resourceId: step.stepId, metadata: { name: step.name } });
    res.status(204).end();
  }));

  return r;
}
