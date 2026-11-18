import { z } from 'zod';
import { defineNode } from '../types.js';

export const manualTrigger = defineNode({
  descriptor: {
    type: 'trigger.manual',
    version: 1,
    displayName: 'Manual Trigger',
    description: 'Start the workflow by clicking “Run” in the editor or the workflow list.',
    category: 'trigger',
    icon: 'mouse-pointer-click',
    isTrigger: true,
    inputs: [],
    outputs: [{ id: 'main' }],
    fields: [
      {
        key: 'testData',
        label: 'Test data (JSON)',
        type: 'json',
        help: 'Optional object (or array of objects) emitted when the workflow is run manually.',
        default: '{}',
      },
    ],
    inputSchema: { description: 'No input. Trigger nodes start the workflow.' },
    outputSchema: {
      description: 'One item per test-data object, or the payload supplied with the run request.',
      example: [{ json: { hello: 'world' } }],
    },
    retryable: true,
    available: true,
    docs: [
      '### Manual Trigger',
      'Starts a run on demand. If the run request carries a JSON payload it is used as the output;',
      'otherwise the **Test data** field is parsed and emitted.',
      '',
      'Output is always a list of items. A JSON array becomes several items.',
    ].join('\n'),
  },
  configSchema: z.object({
    testData: z
      .string()
      .optional()
      .refine((v) => {
        if (!v || !v.trim()) return true;
        try {
          JSON.parse(v);
          return true;
        } catch {
          return false;
        }
      }, 'Test data must be valid JSON'),
  }),
  async execute(ctx) {
    // ctx.items holds the payload provided by the run request, if any.
    if (ctx.items.length > 0) return { outputs: { main: ctx.items } };
    const raw = ctx.config.testData?.trim() ? JSON.parse(ctx.config.testData) : {};
    const list = Array.isArray(raw) ? raw : [raw];
    return { outputs: { main: list.map((v) => ({ json: v && typeof v === 'object' ? v : { value: v } })) } };
  },
});
