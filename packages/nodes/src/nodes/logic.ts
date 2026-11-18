import { z } from 'zod';
import type { Item } from '@widebed/shared';
import { defineNode, NodeError, requireService } from '../types.js';
import { evaluateCondition, OPERATORS } from './if-condition.js';

const conditionSchema = z.object({ left: z.unknown(), operator: z.enum(OPERATORS), right: z.unknown().optional() });
const asText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/* ---------------------------------------------------------------- Switch */

export const switchNode = defineNode({
  descriptor: {
    type: 'logic.switch',
    version: 1,
    displayName: 'Switch',
    description: 'Send each item to the output whose value matches.',
    category: 'logic',
    icon: 'split',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [],
    dynamicOutputs: { from: 'cases', labelKey: 'label', fallback: { id: 'otherwise', label: 'otherwise' } },
    fields: [
      { key: 'value', label: 'Value to check', type: 'string', required: true, expressions: true, placeholder: '{{ $json.status }}' },
      {
        key: 'cases',
        label: 'Cases',
        type: 'cases',
        required: true,
        expressions: true,
        default: [{ id: 'c_1', label: 'confirmed', value: 'confirmed' }],
        help: 'Each case gets its own output. Items that match no case go to “otherwise”.',
      },
      { key: 'caseSensitive', label: 'Case-sensitive comparison', type: 'boolean', default: false },
    ],
    inputSchema: { description: 'Any items.' },
    outputSchema: { description: 'The same items, routed to the first matching case, or to “otherwise”.' },
    retryable: false,
    available: true,
    docs: [
      '### Switch',
      'Like several IF nodes in one. The **value** is computed for each item and compared with each case in order;',
      'the item goes to the **first** matching output. Items that match nothing go to **otherwise**.',
      '',
      'Renaming a case keeps its connection. Deleting a case removes its output and connection.',
    ].join('\n'),
  },
  configSchema: z.object({
    value: z.unknown(),
    cases: z
      .array(z.object({ id: z.string().min(1).max(40), label: z.string().max(60).default(''), value: z.unknown() }))
      .min(1, 'Add at least one case')
      .max(20, 'At most 20 cases'),
    caseSensitive: z.boolean().default(false),
  }),
  async execute(ctx) {
    const outputs: Record<string, Item[]> = { otherwise: [] };
    for (const c of ctx.config.cases) outputs[c.id] = [];
    const norm = (v: unknown) => (ctx.config.caseSensitive ? asText(v) : asText(v).toLowerCase());
    ctx.items.forEach((item, i) => {
      const value = norm(ctx.resolve(ctx.config.value, item, i));
      const match = ctx.config.cases.find((c) => norm(ctx.resolve(c.value, item, i)) === value);
      outputs[match ? match.id : 'otherwise'].push(item);
    });
    return { outputs };
  },
});

/* ---------------------------------------------------------------- Filter */

export const filterNode = defineNode({
  descriptor: {
    type: 'logic.filter',
    version: 1,
    displayName: 'Filter',
    description: 'Keep only the items that match the conditions.',
    category: 'logic',
    icon: 'filter',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    fields: [
      { key: 'conditions', label: 'Keep items where', type: 'conditions', required: true, expressions: true, default: [{ left: '', operator: 'isNotEmpty', right: '' }] },
      {
        key: 'combine',
        label: 'Combine conditions with',
        type: 'select',
        default: 'and',
        options: [
          { label: 'AND — all must match', value: 'and' },
          { label: 'OR — any may match', value: 'or' },
        ],
      },
    ],
    inputSchema: { description: 'Any items.' },
    outputSchema: { description: 'Only the matching items. If none match, the next nodes are skipped.' },
    retryable: false,
    available: true,
    docs: '### Filter\nLike IF, but items that do not match are simply dropped instead of going to a second output.',
  },
  configSchema: z.object({ conditions: z.array(conditionSchema).min(1), combine: z.enum(['and', 'or']).default('and') }),
  async execute(ctx) {
    const kept = ctx.items.filter((item, i) => {
      const r = ctx.config.conditions.map((c) => evaluateCondition(ctx.resolve(c.left, item, i), c.operator, ctx.resolve(c.right, item, i)));
      return ctx.config.combine === 'or' ? r.some(Boolean) : r.every(Boolean);
    });
    return { outputs: { main: kept } };
  },
});

/* ---------------------------------------------------------------- Merge */

export const mergeNode = defineNode({
  descriptor: {
    type: 'logic.merge',
    version: 1,
    displayName: 'Merge',
    description: 'Combine the items arriving from two branches.',
    category: 'logic',
    icon: 'merge',
    isTrigger: false,
    inputs: [
      { id: 'a', label: 'Input 1' },
      { id: 'b', label: 'Input 2' },
    ],
    outputs: [{ id: 'main' }],
    fields: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        default: 'append',
        options: [
          { label: 'Append — all items from Input 1, then Input 2', value: 'append' },
          { label: 'Combine by position — item 1 + item 1, item 2 + item 2…', value: 'byIndex' },
          { label: 'Wait for both — only continue if both inputs have items', value: 'waitBoth' },
          { label: 'Match by fields — join items whose fields are equal (like a lookup)', value: 'matchFields' },
        ],
      },
      {
        key: 'fields',
        label: 'Fields to match (Input 1 field → Input 2 field)',
        type: 'keyValue',
        default: [{ key: 'id', value: 'id' }],
        showIf: { key: 'mode', equals: ['matchFields'] },
        help: 'Field names, e.g. “Property Name” → “Property Name”. All listed pairs must be equal.',
      },
      {
        key: 'join',
        label: 'Keep',
        type: 'select',
        default: 'left',
        showIf: { key: 'mode', equals: ['matchFields'] },
        options: [
          { label: 'All Input 1 items, enriched when a match exists', value: 'left' },
          { label: 'Only Input 1 items that have a match', value: 'inner' },
        ],
      },
    ],
    inputSchema: { description: 'Items on Input 1 and Input 2.' },
    outputSchema: { description: 'The combined items.' },
    retryable: false,
    available: true,
    docs: [
      '### Merge',
      'Runs after **both** branches before it have finished (or been skipped).',
      '- **Append**: puts the lists one after the other.',
      '- **Combine by position**: joins item *n* of Input 1 with item *n* of Input 2 (Input 2 wins on equal keys).',
      '- **Wait for both**: like Append, but outputs nothing if either input is empty.',
      '- **Match by fields**: for each Input 1 item, finds the first Input 2 item with equal field values and joins them.',
      '  Input 1 values win, except empty ones, which are filled from Input 2.',
    ].join('\n'),
  },
  configSchema: z.object({
    mode: z.enum(['append', 'byIndex', 'waitBoth', 'matchFields']).default('append'),
    fields: z.array(z.object({ key: z.string(), value: z.unknown() })).default([]),
    join: z.enum(['left', 'inner']).default('left'),
  }).refine((c) => c.mode !== 'matchFields' || c.fields.some((f) => f.key.trim()), { message: 'Add at least one field pair to match', path: ['fields'] }),
  async execute(ctx) {
    const a = ctx.inputs.a ?? [];
    const b = ctx.inputs.b ?? [];
    if (ctx.config.mode === 'byIndex') {
      const n = Math.max(a.length, b.length);
      const out: Item[] = [];
      for (let i = 0; i < n; i++) out.push({ json: { ...(a[i]?.json ?? {}), ...(b[i]?.json ?? {}) } });
      return { outputs: { main: out } };
    }
    if (ctx.config.mode === 'matchFields') {
      const pairs = ctx.config.fields.filter((f) => f.key.trim()).map((f) => [f.key.trim(), String(f.value ?? '').trim() || f.key.trim()] as const);
      const keyOf = (json: Record<string, unknown>, side: 0 | 1) => pairs.map((p) => asText(json[p[side]]).trim()).join('\u0000');
      const lookup = new Map<string, Item>();
      for (const item of b) {
        const k = keyOf(item.json, 1);
        if (!lookup.has(k)) lookup.set(k, item);
      }
      const isEmpty = (v: unknown) => v === null || v === undefined || v === '';
      const out: Item[] = [];
      for (const item of a) {
        const match = lookup.get(keyOf(item.json, 0));
        if (!match) {
          if (ctx.config.join === 'left') out.push(item);
          continue;
        }
        const merged: Record<string, unknown> = { ...match.json };
        for (const [k, v] of Object.entries(item.json)) if (!isEmpty(v) || !(k in merged)) merged[k] = v;
        out.push({ json: merged });
      }
      return { outputs: { main: out } };
    }
    if (ctx.config.mode === 'waitBoth' && (!a.length || !b.length)) return { outputs: { main: [] } };
    return { outputs: { main: [...a, ...b] } };
  },
});

/* ---------------------------------------------------------------- Loop */

export const loopNode = defineNode({
  descriptor: {
    type: 'logic.loop',
    version: 1,
    displayName: 'Loop',
    description: 'Turn a list into separate items so the next nodes run once per entry.',
    category: 'logic',
    icon: 'repeat',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    fields: [
      {
        key: 'mode',
        label: 'Loop over',
        type: 'select',
        default: 'list',
        options: [
          { label: 'Each entry of a list', value: 'list' },
          { label: 'A fixed number of times', value: 'count' },
        ],
      },
      { key: 'list', label: 'List', type: 'string', expressions: true, placeholder: '{{ $json.body.rooms }}', showIf: { key: 'mode', equals: ['list'] } },
      { key: 'itemKey', label: 'Put each entry in field', type: 'string', default: 'item', showIf: { key: 'mode', equals: ['list'] } },
      { key: 'keepParent', label: 'Keep the original fields too', type: 'boolean', default: true, showIf: { key: 'mode', equals: ['list'] } },
      { key: 'count', label: 'Times', type: 'number', default: 3, expressions: true, showIf: { key: 'mode', equals: ['count'] } },
    ],
    inputSchema: { description: 'Any items.' },
    outputSchema: {
      description: 'One item per list entry (or per repetition), with `index` and the entry.',
      example: [{ json: { index: 0, item: { room: '12A' } } }],
    },
    retryable: false,
    available: true,
    docs: [
      '### Loop',
      'Every node after this one processes **each item separately** — so splitting a list into items is how you loop.',
      'Example: a booking with `rooms: [...]` → one item per room → an HTTP Request per room.',
      '',
      'Each output item has `index` (0, 1, 2…) and the entry under the chosen field name.',
    ].join('\n'),
  },
  configSchema: z.object({
    mode: z.enum(['list', 'count']).default('list'),
    list: z.unknown().optional(),
    itemKey: z.string().regex(/^[A-Za-z_][\w]*$/, 'Use letters, digits and _ only').default('item'),
    keepParent: z.boolean().default(true),
    count: z.unknown().optional(),
  }),
  async execute(ctx) {
    const out: Item[] = [];
    ctx.items.forEach((item, i) => {
      if (ctx.config.mode === 'count') {
        const n = Number(ctx.resolve(ctx.config.count ?? 0, item, i));
        if (!Number.isInteger(n) || n < 0 || n > 5000) throw new NodeError(`Times must be a whole number from 0 to 5000 (got ${n})`);
        for (let k = 0; k < n; k++) out.push({ json: { ...item.json, index: k } });
        return;
      }
      const list = ctx.resolve(ctx.config.list, item, i);
      if (!Array.isArray(list)) throw new NodeError(`“List” must be an array, got ${list === undefined ? 'nothing' : typeof list}`, { code: 'NOT_A_LIST' });
      list.forEach((entry, k) => {
        out.push({ json: { ...(ctx.config.keepParent ? item.json : {}), index: k, [ctx.config.itemKey]: entry } });
      });
    });
    return { outputs: { main: out } };
  },
});

/* ---------------------------------------------------------------- Wait */

const UNIT_MS = { seconds: 1000, minutes: 60_000, hours: 3_600_000 } as const;

export const waitNode = defineNode({
  descriptor: {
    type: 'logic.wait',
    version: 1,
    displayName: 'Wait / Delay',
    description: 'Pause the workflow for a while, then continue.',
    category: 'logic',
    icon: 'timer',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    fields: [
      { key: 'amount', label: 'Wait for', type: 'number', default: 30, required: true },
      {
        key: 'unit',
        label: 'Unit',
        type: 'select',
        default: 'seconds',
        options: [
          { label: 'Seconds', value: 'seconds' },
          { label: 'Minutes', value: 'minutes' },
          { label: 'Hours', value: 'hours' },
        ],
      },
    ],
    inputSchema: { description: 'Any items.' },
    outputSchema: { description: 'The same items, after the delay.' },
    retryable: false,
    available: true,
    docs: [
      '### Wait / Delay',
      'The execution shows status **Waiting** during the pause and can be cancelled.',
      'The maximum wait is set by the administrator (`WAIT_MAX_MS`, default 1 hour), and the workflow',
      'timeout must be longer than the wait. For “run tomorrow at 9:00” use a Schedule Trigger instead.',
    ].join('\n'),
  },
  configSchema: z.object({
    amount: z.coerce.number().min(0, 'Must be 0 or more'),
    unit: z.enum(['seconds', 'minutes', 'hours']).default('seconds'),
  }),
  async execute(ctx) {
    const wait = requireService(ctx.services, 'wait', 'Waiting');
    await wait(ctx.config.amount * UNIT_MS[ctx.config.unit], ctx.signal);
    return { outputs: { main: ctx.items } };
  },
});

/* ---------------------------------------------------------------- Combine */

export const combineNode = defineNode({
  descriptor: {
    type: 'logic.combine',
    version: 1,
    displayName: 'Combine into One',
    description: 'Turn many items into one — e.g. one summary email instead of one email per row.',
    category: 'logic',
    icon: 'layers',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    fields: [
      {
        key: 'line',
        label: 'One line per item',
        type: 'string',
        required: true,
        expressions: true,
        default: '• {{ $json.title }}',
        help: 'Written once for every item, e.g. “• {{ $json.unit }} – {{ $json.title }}”. The lines are joined into one text.',
      },
      { key: 'saveAs', label: 'Save the text as', type: 'string', default: 'list', help: 'Next steps use it as {{ $json.list }} and the number of items as {{ $json.count }}.' },
      {
        key: 'sortBy',
        label: 'Sort by (optional)',
        type: 'string',
        default: '',
        placeholder: 'arrival',
        help: 'A field name to sort the lines by (A→Z, oldest date first). Leave empty to keep the order.',
      },
    ],
    inputSchema: { description: 'Any number of items. When nothing arrives, the steps after it do not run.' },
    outputSchema: {
      description: 'One item: { count, list (the text), items (all the original items) }.',
      example: [{ json: { count: 2, list: '• A-12 – Leaking tap\n• B-03 – No hot water', items: [{ unit: 'A-12' }, { unit: 'B-03' }] } }],
    },
    retryable: false,
    available: true,
    docs: [
      '### Combine into One',
      'Use it before a Gmail step to send **one** email with a list, instead of one email per item.',
      '',
      '**Example** — open issues digest:',
      '- One line per item: `• {{ $json.unit }} – {{ $json.title }} (raised by {{ $json.raisedBy }})`',
      '- Gmail body: `There are {{ $json.count }} open issues:\\n\\n{{ $json.list }}`',
      '',
      'If no items arrive (nothing to report), the steps after it are skipped, so no empty email is sent.',
    ].join('\n'),
  },
  configSchema: z.object({
    line: z.unknown().refine((v) => typeof v === 'string' && v.trim() !== '', 'Write what one line should say'),
    saveAs: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,59}$/, 'Use letters, numbers and _ only (e.g. list)').default('list'),
    sortBy: z.string().default(''),
  }),
  async execute(ctx) {
    let items = ctx.items.map((item, i) => ({ item, i }));
    const key = ctx.config.sortBy.trim();
    if (key) {
      const val = (x: Item) => {
        const v = x.json[key];
        return v === null || v === undefined ? '' : typeof v === 'number' ? v : String(v);
      };
      items = [...items].sort((a, b) => {
        const x = val(a.item);
        const y = val(b.item);
        return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      });
    }
    const lines = items.map(({ item, i }) => {
      const v = ctx.resolve(ctx.config.line, item, i);
      return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
    return { outputs: { main: [{ json: { count: ctx.items.length, [ctx.config.saveAs]: lines.join('\n'), items: items.map(({ item }) => item.json) } }] } };
  },
});
