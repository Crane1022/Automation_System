import { z } from 'zod';
import type { Item } from '@widebed/shared';
import { defineNode, NodeError, requireService } from '../types.js';

export const CODE_DEFAULT = `// "items" is a list of objects (one per incoming item).
// Return a list of objects — each becomes an output item.
return items.map((item) => ({
  ...item,
  processedAt: new Date().toISOString(),
}));
`;

export const codeNode = defineNode({
  descriptor: {
    type: 'data.code',
    version: 1,
    displayName: 'Code Execution',
    description: 'Transform items with JavaScript, in an isolated sandbox.',
    category: 'data',
    icon: 'code',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    fields: [
      { key: 'code', label: 'JavaScript', type: 'code', required: true, default: CODE_DEFAULT },
      { key: 'timeoutMs', label: 'Time limit (ms)', type: 'number', default: 5000, help: 'Maximum 30 000 ms.' },
    ],
    inputSchema: { description: 'Any items. Your code receives `items` — an array of plain objects.' },
    outputSchema: { description: 'Whatever list of objects your code returns.' },
    retryable: false,
    available: true,
    docs: [
      '### Code Execution',
      'Runs in a **separate process** with no file system, no child processes, no `require`/`import`,',
      'a memory cap and a time limit. Input and output are plain JSON.',
      '',
      '- `items` — array of objects from the previous node',
      '- return an array of objects (or a single object)',
      '- `console.log` is ignored; return data instead',
      '',
      'Only **IT Admins** and **Super Admins** can save or publish workflows that contain a Code node.',
    ].join('\n'),
  },
  configSchema: z.object({
    code: z.string().min(1, 'Write some code').max(50_000, 'Code is too long (50 000 characters max)'),
    timeoutMs: z.coerce.number().int().min(100).max(30_000).default(5000),
  }),
  async execute(ctx) {
    const run = requireService(ctx.services, 'runCode', 'Code execution');
    const result = await run(ctx.config.code, ctx.items.map((i) => i.json), { timeoutMs: ctx.config.timeoutMs, signal: ctx.signal });
    const list = Array.isArray(result) ? result : result === undefined || result === null ? [] : [result];
    const out: Item[] = list.map((v, i) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        throw new NodeError(`Returned entry ${i} is not an object. Return objects like { name: "x" }.`, { code: 'BAD_RETURN' });
      }
      return { json: v as Record<string, unknown> };
    });
    return { outputs: { main: out } };
  },
});
