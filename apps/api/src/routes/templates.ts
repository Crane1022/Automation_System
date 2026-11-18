import { Router } from 'express';
import { z } from 'zod';
import { BUILT_IN_TEMPLATES, TEMPLATE_CATEGORIES, canViewWorkflow, hasPermission, templateSafeDefinition, type WorkflowTemplate } from '@widebed/shared';
import type { AppContext } from '../context.js';
import { ah } from '../middleware/errors.js';
import { forbidden, notFound } from '../lib/http-error.js';
import { newId, nowIso } from '../lib/ids.js';

/**
 * Workflow templates.
 *   GET    /api/templates        built-in + saved templates
 *   POST   /api/templates        save one of your workflows as a template (no connections are kept)
 *   DELETE /api/templates/:id    remove a saved template (its creator or an admin)
 * Using a template goes through POST /api/workflows/import, so every import check applies.
 */
const saveSchema = z.object({
  workflowId: z.string().min(1).max(100),
  name: z.string().trim().min(1, 'Give the template a name').max(120),
  description: z.string().trim().max(500).default(''),
  category: z.enum(TEMPLATE_CATEGORIES).default('Custom'),
  needs: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  setup: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
});

export function templatesRouter(ctx: AppContext) {
  const r = Router();

  r.get('/', ah(async (_req, res) => {
    const saved = await ctx.repos.templates.list(500);
    res.json({ builtIn: BUILT_IN_TEMPLATES, saved });
  }));

  r.post('/', ah(async (req, res) => {
    const user = req.user!;
    if (!hasPermission(user, 'workflow.create')) throw forbidden('Only people who build workflows can save templates');
    const body = saveSchema.parse(req.body);
    const wf = await ctx.repos.workflows.get(body.workflowId);
    if (!wf || !canViewWorkflow(user, wf)) throw notFound('Workflow not found');
    const t: WorkflowTemplate = {
      templateId: newId('tpl'),
      name: body.name,
      description: body.description || wf.description,
      category: body.category,
      needs: body.needs,
      setup: body.setup.length ? body.setup : ['Choose the connections on the steps marked with a warning.', 'Click “Test run”, then “Publish” and switch it to Active.'],
      definition: templateSafeDefinition(wf.draftDefinition),
      builtIn: false,
      createdBy: user.uid,
      createdByName: user.name,
      createdAt: nowIso(),
    };
    await ctx.repos.templates.create(t);
    await ctx.audit({ actorId: user.uid, action: 'template.create', resourceType: 'template', resourceId: t.templateId, metadata: { fromWorkflow: wf.workflowId } });
    res.status(201).json(t);
  }));

  r.delete('/:id', ah(async (req, res) => {
    const user = req.user!;
    const t = await ctx.repos.templates.get(req.params.id);
    if (!t) throw notFound('Template not found');
    if (t.createdBy !== user.uid && !hasPermission(user, 'workflow.manageAll')) throw forbidden('Only the person who saved it or an admin can delete this template');
    await ctx.repos.templates.delete(t.templateId);
    await ctx.audit({ actorId: user.uid, action: 'template.delete', resourceType: 'template', resourceId: t.templateId });
    res.status(204).end();
  }));

  return r;
}
