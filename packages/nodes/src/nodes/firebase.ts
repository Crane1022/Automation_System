import { z } from 'zod';
import type { FieldDescriptor, Item, NodeDescriptor } from '@widebed/shared';
import { defineNode, NodeError, requireService, type FirestoreAccess } from '../types.js';

/**
 * Firebase Read / Create / Update / Delete for OUTSIDE Firebase projects (PMS, TMS…).
 * The credential decides which project and which collections are reachable;
 * the API enforces that list — these nodes cannot see anything else.
 */

const PROVIDER = 'firebase_service_account';
const pathSchema = z.string().trim().min(1, 'Required').max(500).regex(/^[^\s]+$/, 'No spaces in paths');

const collectionField: FieldDescriptor = {
  key: 'collection',
  label: 'Collection',
  type: 'string',
  required: true,
  expressions: true,
  placeholder: 'bookings',
  help: 'Must be in the credential’s allowed collections. Sub-collections: tenants/{{ $json.tenantId }}/payments. Query mode can also search the same sub-collection of every document: tenants/*/private.',
};
const docIdField = (required: boolean): FieldDescriptor => ({
  key: 'docId',
  label: required ? 'Document ID' : 'Document ID (optional)',
  type: 'string',
  required,
  expressions: true,
  placeholder: '{{ $json.bookingId }}',
});
const dataField: FieldDescriptor = {
  key: 'data',
  label: 'Data (JSON)',
  type: 'code',
  required: true,
  expressions: true,
  default: '{\n  "status": "{{ $json.status }}"\n}',
  help: 'A JSON object. Use {{ }} to insert values. Use a single expression like {{ $json.body }} to write a whole object.',
};

async function access(ctx: { services: Parameters<typeof requireService>[0]; node: { credentialId?: string | null } }): Promise<FirestoreAccess> {
  if (!ctx.node.credentialId) throw new NodeError('Choose a Firebase connection for this node', { code: 'NO_CREDENTIAL' });
  return requireService(ctx.services, 'firestore', 'Firebase access')(ctx.node.credentialId);
}

function parseData(value: unknown): Record<string, unknown> {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch (err) {
      throw new NodeError(`Data is not valid JSON: ${(err as Error).message}`, { code: 'INVALID_JSON' });
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new NodeError('Data must be a JSON object', { code: 'INVALID_JSON' });
  return v as Record<string, unknown>;
}

const join = (collection: string, id: string) => `${collection.replace(/\/+$/, '')}/${id}`;

function base(type: string, name: string, description: string, icon: string, fields: FieldDescriptor[], retryable: boolean, output: string, docs: string): NodeDescriptor {
  return {
    type,
    version: 1,
    displayName: name,
    description,
    category: 'data',
    icon,
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    fields,
    inputSchema: { description: 'Any items. The operation runs once per item.' },
    outputSchema: { description: output },
    credentialProvider: PROVIDER,
    retryable,
    available: true,
    docs: `${docs}\n\nRequires a **Firebase / Firestore project** connection (Credentials page). Only the collections listed in that connection can be used.`,
  };
}

/* ---------------------------------------------------------------- Read */

const OPS = ['==', '!=', '<', '<=', '>', '>=', 'array-contains', 'in'] as const;

export const firebaseRead = defineNode({
  descriptor: base(
    'data.firebaseRead',
    'Firebase Read',
    'Get one document or query a collection.',
    'database',
    [
      {
        key: 'mode',
        label: 'Read',
        type: 'select',
        default: 'query',
        options: [
          { label: 'Query a collection', value: 'query' },
          { label: 'One document by ID', value: 'get' },
        ],
      },
      collectionField,
      { ...docIdField(true), showIf: { key: 'mode', equals: ['get'] } },
      {
        key: 'saveAs',
        label: 'Add to each incoming item as (optional)',
        type: 'string',
        placeholder: 'guest',
        help: 'Look up for every item and keep the item: the document (in “Query” mode: the first match) goes in this field ({{ $json.guest.email }}). Not found → null, and the item still continues, so an IF step can check “found or not”. Leave empty to output only the documents.',
      },
      { key: 'where', label: 'Filters', type: 'firestoreFilters', expressions: true, default: [], showIf: { key: 'mode', equals: ['query'] } },
      { key: 'orderBy', label: 'Order by field', type: 'string', showIf: { key: 'mode', equals: ['query'] } },
      {
        key: 'direction',
        label: 'Direction',
        type: 'select',
        default: 'asc',
        showIf: { key: 'mode', equals: ['query'] },
        options: [
          { label: 'Ascending', value: 'asc' },
          { label: 'Descending', value: 'desc' },
        ],
      },
      { key: 'limit', label: 'Max documents', type: 'number', default: 50, showIf: { key: 'mode', equals: ['query'] }, help: '1 – 500' },
    ],
    true,
    'One item per document: { id, path, ...fields }. Timestamps become ISO date strings.',
    '### Firebase Read\nQuery mode returns one item per matching document. “One document” returns nothing (and later nodes are skipped) if it does not exist.\n\n**Find a guest (found / not found):** Query mode with a filter such as `phone` == `{{ $json.body.profile.phone }}` and “Add to each incoming item as” = `guest`. The item continues with `guest` = the first match or `null`; an IF step on `{{ $json.guest }}` *is not empty* then splits returning and new guests. Put a value in double quotes (`\"{{ $json.phoneKey }}\"`) to compare it as text, not as a number.\n\n**Look up for each item:** in “One document” mode, fill in “Add to each incoming item as” (e.g. `guest`). Every item then keeps its own fields and gets the document in that field — like a VLOOKUP. A missing document gives `null` instead of stopping.\nFiltering on one field and ordering by another may need a Firestore index in that project — the error message contains a link to create it.',
  ),
  configSchema: z.object({
    mode: z.enum(['query', 'get']).default('query'),
    collection: pathSchema,
    docId: z.string().optional(),
    saveAs: z.string().trim().max(60).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use letters, numbers and _ only (e.g. guest)').optional().or(z.literal('')),
    where: z.array(z.object({ field: z.string().min(1, 'Field is required'), op: z.enum(OPS), value: z.unknown() })).max(10).default([]),
    orderBy: z.string().optional(),
    direction: z.enum(['asc', 'desc']).default('asc'),
    limit: z.coerce.number().int().min(1).max(500).default(50),
  }),
  async execute(ctx) {
    const fs = await access(ctx);
    const out: Item[] = [];
    const items = ctx.items.length ? ctx.items : [{ json: {} }];
    const first = ctx.resolve(ctx.config, items[0], 0);
    if (first.mode === 'get' && first.saveAs) {
      // Lookup mode: one read per item, 10 at a time (one by one was too slow for hundreds of bookings).
      const results: Item[] = new Array(items.length);
      let next = 0;
      const worker = async () => {
        while (next < items.length) {
          const i = next++;
          const c = i === 0 ? first : ctx.resolve(ctx.config, items[i], i);
          const saveAs = String(c.saveAs || first.saveAs);
          const id = c.docId == null ? '' : String(c.docId).trim();
          const full = join(String(c.collection).trim(), id);
          const blank = !id || /\/\//.test(full) || full.endsWith('/') || /(^|\/)(undefined|null)(\/|$)/.test(full);
          const doc = blank ? null : await fs.get(full);
          results[i] = { json: { ...items[i]!.json, [saveAs]: doc ? { id: doc.id, ...doc.data } : null } };
        }
      };
      await Promise.all(Array.from({ length: Math.min(10, items.length) }, worker));
      return { outputs: { main: results } };
    }
    for (let i = 0; i < items.length; i++) {
      const c = ctx.resolve(ctx.config, items[i], i);
      if (c.mode === 'query' && c.saveAs) {
        // Query lookup: keep the item, add the first matching document (or null).
        const blank = c.where.some((w) => w.value === undefined || w.value === null || (typeof w.value === 'string' && !w.value.trim().replace(/^""$/, '')));
        const docs = blank
          ? []
          : await fs.query(c.collection, {
              where: c.where.map((w) => ({ ...w, value: coerce(w.value, w.op) })),
              orderBy: c.orderBy ? { field: c.orderBy, direction: c.direction } : undefined,
              limit: 1,
            });
        const d = docs[0];
        out.push({ json: { ...items[i]!.json, [c.saveAs]: d ? { id: d.id, ...d.data } : null } });
        continue;
      }
      if (c.mode === 'get' && c.saveAs) {
        // Lookup mode: the item always continues, with the document (or null) added to it.
        const id = c.docId == null ? '' : String(c.docId).trim();
        const full = join(String(c.collection).trim(), id);
        // A blank part (e.g. tenants/{{ $json.tenantId }}/private with no tenantId) means "nothing to look up".
        const blank = !id || /\/\//.test(full) || full.endsWith('/') || /(^|\/)(undefined|null)(\/|$)/.test(full);
        const doc = blank ? null : await fs.get(full);
        out.push({ json: { ...items[i]!.json, [c.saveAs]: doc ? { id: doc.id, ...doc.data } : null } });
      } else if (c.mode === 'get') {
        if (!c.docId) throw new NodeError('Document ID is empty', { code: 'NO_DOC_ID' });
        const doc = await fs.get(join(c.collection, String(c.docId)));
        if (doc) out.push({ json: { id: doc.id, path: doc.path, ...doc.data } });
      } else {
        const docs = await fs.query(c.collection, {
          where: c.where.map((w) => ({ ...w, value: coerce(w.value, w.op) })),
          orderBy: c.orderBy ? { field: c.orderBy, direction: c.direction } : undefined,
          limit: c.limit,
        });
        for (const d of docs) out.push({ json: { id: d.id, path: d.path, ...d.data } });
      }
    }
    return { outputs: { main: out } };
  },
});

/** Filter values typed in the UI are text; turn "12", "true", "[1,2]" into real values. */
function coerce(value: unknown, op: string): unknown {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (op === 'in') {
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through: comma list */
    }
    return t.split(',').map((s) => coerce(s, '=='));
  }
  // "60123456789" in double quotes stays text (phone numbers, IDs made of digits).
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (t !== '' && !Number.isNaN(Number(t)) && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return value;
}

/* ---------------------------------------------------------------- Create */

export const firebaseCreate = defineNode({
  descriptor: base(
    'data.firebaseCreate',
    'Firebase Create',
    'Add a new document to a collection.',
    'database',
    [collectionField, docIdField(false), dataField],
    false,
    'One item per created document: { id, path }.',
    '### Firebase Create\nLeave the ID empty to let Firestore generate one. If you give an ID that already exists, the node fails instead of overwriting.',
  ),
  configSchema: z.object({ collection: pathSchema, docId: z.string().optional(), data: z.unknown() }),
  async execute(ctx) {
    const fs = await access(ctx);
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const c = ctx.resolve(ctx.config, ctx.items[i], i);
      const res = await fs.create(c.collection, parseData(c.data), c.docId ? String(c.docId) : undefined);
      out.push({ json: res });
    }
    return { outputs: { main: out } };
  },
});

/* ---------------------------------------------------------------- Update */

export const firebaseUpdate = defineNode({
  descriptor: base(
    'data.firebaseUpdate',
    'Firebase Update',
    'Change fields of an existing document.',
    'database',
    [
      collectionField,
      docIdField(true),
      dataField,
      {
        key: 'mode',
        label: 'If the document does not exist',
        type: 'select',
        default: 'fail',
        options: [
          { label: 'Fail', value: 'fail' },
          { label: 'Create it (merge)', value: 'merge' },
        ],
      },
    ],
    true,
    'One item per updated document: { id, path }.',
    '### Firebase Update\nOnly the fields you send are changed; other fields are kept.',
  ),
  configSchema: z.object({ collection: pathSchema, docId: z.string().min(1, 'Document ID is required'), data: z.unknown(), mode: z.enum(['fail', 'merge']).default('fail') }),
  async execute(ctx) {
    const fs = await access(ctx);
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const c = ctx.resolve(ctx.config, ctx.items[i], i);
      const path = join(c.collection, String(c.docId));
      await fs.update(path, parseData(c.data), c.mode === 'merge');
      out.push({ json: { id: String(c.docId), path } });
    }
    return { outputs: { main: out } };
  },
});

/* ---------------------------------------------------------------- Delete */

export const firebaseDelete = defineNode({
  descriptor: base(
    'data.firebaseDelete',
    'Firebase Delete',
    'Delete a document.',
    'database',
    [collectionField, docIdField(true)],
    true,
    'One item per deleted document: { id, path, deleted: true }.',
    '### Firebase Delete\nDeleting a document does not delete its sub-collections. Deleting a document that does not exist succeeds.',
  ),
  configSchema: z.object({ collection: pathSchema, docId: z.string().min(1, 'Document ID is required') }),
  async execute(ctx) {
    const fs = await access(ctx);
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const c = ctx.resolve(ctx.config, ctx.items[i], i);
      const path = join(c.collection, String(c.docId));
      await fs.delete(path);
      out.push({ json: { id: String(c.docId), path, deleted: true } });
    }
    return { outputs: { main: out } };
  },
});
