import { z } from 'zod';
import { defineNode, NodeError } from '../types.js';

/**
 * Placeholder for imported nodes this platform cannot run yet (e.g. n8n Google Sheets
 * before Phase 3). It keeps the node's position, connections and original settings so
 * the imported workflow stays readable. It always blocks Publish, and fails if a test
 * run reaches it.
 */
export const UNSUPPORTED_TYPE = 'util.unsupported';

export const unsupportedNode = defineNode({
  descriptor: {
    type: UNSUPPORTED_TYPE,
    version: 1,
    displayName: 'Needs replacing',
    description: 'Imported node that this platform does not support yet.',
    category: 'data',
    icon: 'box',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [],
    dynamicOutputs: { from: 'outputs', labelKey: 'label' },
    fields: [
      { key: 'originalType', label: 'Original node type', type: 'string' },
      { key: 'reason', label: 'Why it was not converted', type: 'text' },
      { key: 'originalParameters', label: 'Original settings (for reference)', type: 'code' },
    ],
    inputSchema: { description: 'Not run.' },
    outputSchema: { description: 'Not run.' },
    retryable: false,
    available: false,
    docs: [
      '### Needs replacing',
      'This node came from an imported workflow and has no equivalent here yet.',
      'Its original settings are kept below so you can rebuild it with available nodes,',
      'or wait for the phase that adds it (AI nodes arrive in Phase 3).',
      '',
      'The workflow cannot be published while this node is present.',
    ].join('\n'),
  },
  configSchema: z.object({
    originalType: z.string().default(''),
    reason: z.string().default(''),
    originalParameters: z.string().default(''),
    outputs: z.array(z.object({ id: z.string(), label: z.string() })).default([{ id: 'main', label: '' }]),
  }),
  async execute(ctx) {
    throw new NodeError(`“${ctx.node.name}” (${String(ctx.config.originalType)}) is not supported yet — replace it before running`, { code: 'UNSUPPORTED_NODE' });
  },
});
