import { z } from 'zod';
import { CUSTOM_STEP_BLOCKED_TYPES, CUSTOM_STEP_TYPE, customStepConfig } from '@widebed/shared';
import { defineNode, NodeError, requireService, type NodeImplementation } from '../types.js';

/** Looks up node types; the registry is passed in so this node can run the step it is built on. */
export interface StepLookup {
  get(type: string): NodeImplementation | undefined;
}

/**
 * A reusable step saved by someone in the team ("My team's steps").
 * The workflow only stores which saved step it is and the values of the boxes
 * the team may change; the saved step holds everything else.
 */
export function customStepNode(lookup: StepLookup) {
  return defineNode({
    descriptor: {
      type: CUSTOM_STEP_TYPE,
      version: 1,
      displayName: 'Team step',
      description: 'A step saved by your team, with its settings already filled in.',
      category: 'data',
      icon: 'package',
      isTrigger: false,
      inputs: [{ id: 'main' }],
      outputs: [{ id: 'main' }],
      fields: [
        { key: 'stepId', label: 'Saved step', type: 'string', required: true },
        { key: 'values', label: 'Values', type: 'json' },
      ],
      inputSchema: { description: 'Same as the step it is built on.' },
      outputSchema: { description: 'Same as the step it is built on.' },
      retryable: false,
      // Listed under "My team's steps", not in the normal step list.
      available: false,
      docs: [
        '### Team step',
        'Someone in your team set this step up once and saved it. Only the boxes they chose are shown here;',
        'everything else (address, connection, fixed settings) comes from the saved step.',
        '',
        'When they improve the saved step, every workflow that uses it gets the change.',
      ].join('\n'),
    },
    configSchema: z.object({
      stepId: z.string().min(1, 'choose a saved step'),
      values: z.record(z.unknown()).default({}),
    }),
    async execute(ctx) {
      const find = requireService(ctx.services, 'customStep', 'Team steps');
      const step = await find(ctx.config.stepId);
      if (!step) throw new NodeError(`“${ctx.node.name}”: the saved team step was deleted or is not shared with this workflow's team`, { code: 'CUSTOM_STEP_MISSING' });
      if (CUSTOM_STEP_BLOCKED_TYPES.includes(step.baseType)) throw new NodeError(`“${step.name}” cannot run as a team step`, { code: 'CUSTOM_STEP_BLOCKED' });
      const base = lookup.get(step.baseType);
      if (!base || base.descriptor.isTrigger) throw new NodeError(`“${step.name}” is built on a step type that is not available (${step.baseType})`, { code: 'CUSTOM_STEP_BASE' });
      const merged = customStepConfig(step, ctx.config.values);
      const parsed = base.configSchema.safeParse(merged);
      if (!parsed.success) {
        const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'settings'} — ${i.message}`).join('; ');
        throw new NodeError(`“${ctx.node.name}” (${step.name}): ${msg}`, { code: 'INVALID_CONFIG' });
      }
      return base.execute({
        ...ctx,
        config: parsed.data,
        node: { ...ctx.node, type: step.baseType, config: merged, credentialId: step.credentialId ?? ctx.node.credentialId },
      });
    },
  });
}
