import type { Credential, Workflow, WorkflowConnection, WorkflowDefinition, WorkflowNode } from '@widebed/shared';
import { parsePath } from '@widebed/engine';

/**
 * Import / export of workflows.
 *
 *  - Native format: what "Export" downloads. Re-importing gives the same workflow.
 *  - n8n format: workflows exported from n8n are converted node by node. Nodes with
 *    no equivalent yet become "Needs replacing" placeholders that keep their original
 *    settings and connections, and everything is listed in an import report.
 *
 * Secrets never travel in either format: credentials are only referenced by name,
 * and must be connected again in the target system.
 */

export const EXPORT_FORMAT = 'widebed-automation/workflow';

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  formatVersion: 1;
  exportedAt: string;
  workflow: { name: string; description: string; tags: string[]; definition: WorkflowDefinition };
  /** Which connections the nodes used, so they can be matched on import. No secrets. */
  credentials: { credentialId: string; name: string; provider: string }[];
}

export interface ImportReport {
  source: 'widebed' | 'n8n';
  converted: { name: string; from: string; to: string }[];
  unsupported: { name: string; type: string; reason: string }[];
  warnings: string[];
  /** Nodes that need a connection chosen after import. */
  needsCredential: string[];
}

export interface ImportResult {
  name: string;
  description: string;
  tags: string[];
  definition: WorkflowDefinition;
  report: ImportReport;
}

export class ImportError extends Error {}

/* ================================================================== export */

export function exportWorkflow(wf: Workflow, credentials: Credential[]): ExportFile {
  const used = new Set(wf.draftDefinition.nodes.map((n) => n.credentialId).filter(Boolean));
  return {
    format: EXPORT_FORMAT,
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    workflow: { name: wf.name, description: wf.description, tags: wf.tags, definition: wf.draftDefinition },
    credentials: credentials.filter((c) => used.has(c.credentialId)).map((c) => ({ credentialId: c.credentialId, name: c.name, provider: c.provider })),
  };
}

/* ================================================================== import */

export function detectFormat(file: unknown): 'widebed' | 'n8n' {
  const f = file as any;
  if (f?.format === EXPORT_FORMAT) return 'widebed';
  if (Array.isArray(f?.nodes) && f?.connections && typeof f.connections === 'object' && f.nodes.some((n: any) => typeof n?.type === 'string' && n.type.includes('n8n-nodes-'))) return 'n8n';
  throw new ImportError('This file is not a Widebed Automation export or an n8n workflow (.json)');
}

/**
 * Re-links credentials by id, or by name + type, among the connections the importing
 * user can see. Anything else is cleared and reported.
 */
export function relinkCredentials(definition: WorkflowDefinition, refs: ExportFile['credentials'], visible: Credential[], report: ImportReport, providerOf: (type: string) => string | undefined) {
  for (const node of definition.nodes) {
    const provider = providerOf(node.type);
    if (!provider) {
      delete node.credentialId;
      continue;
    }
    const ref = refs.find((r) => r.credentialId === node.credentialId);
    const match =
      visible.find((c) => c.credentialId === node.credentialId && c.provider === provider) ??
      (ref ? visible.find((c) => c.name === ref.name && c.provider === provider) : undefined);
    if (match) {
      node.credentialId = match.credentialId;
    } else {
      node.credentialId = null;
      if (!report.needsCredential.includes(node.name)) report.needsCredential.push(node.name);
    }
  }
}

export function importNative(file: ExportFile): ImportResult {
  const w = file.workflow;
  if (!w?.definition || !Array.isArray(w.definition.nodes)) throw new ImportError('The export file is incomplete (no workflow definition)');
  return {
    name: String(w.name ?? 'Imported workflow'),
    description: String(w.description ?? ''),
    tags: Array.isArray(w.tags) ? w.tags.map(String) : [],
    definition: { schemaVersion: 1, nodes: w.definition.nodes, connections: w.definition.connections ?? [], settings: w.definition.settings ?? {} },
    report: { source: 'widebed', converted: [], unsupported: [], warnings: [], needsCredential: [] },
  };
}

/* ================================================================== n8n */

interface N8nNode {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  position?: [number, number];
  parameters?: Record<string, any>;
  disabled?: boolean;
  notes?: string;
  credentials?: Record<string, { id?: string; name?: string }>;
}

type Converted = { type: string; config: Record<string, unknown>; outputs?: string[]; inputs?: string[]; notes?: string[] };

const safeId = (s: string, i: number) => (s && /^[A-Za-z0-9_-]{1,100}$/.test(s) ? s : `n8n_${i}`);

/**
 * Converts one n8n expression or value to this platform's syntax.
 *   "={{ $json.Email }}"               → "{{ $json.Email }}"
 *   "={{ true }}" / "={{ \"\" }}"      → true / ""
 *   "$('Code').item.json.ID"           → "$node[\"Code\"].json.ID"  (first item; warned)
 * Anything that is not a simple property path is kept and reported.
 */
export function convertValue(value: unknown, warn: (msg: string) => void, where: string): unknown {
  if (typeof value !== 'string') return value;
  if (!value.startsWith('=')) return value;
  let text = value.slice(1);
  const single = text.match(/^\s*\{\{\s*([\s\S]+?)\s*\}\}\s*$/);
  if (single) {
    const lit = literal(single[1]);
    if (lit.ok) return lit.value;
  }
  text = text.replace(/\{\{\s*([\s\S]+?)\s*\}\}/g, (whole, expr: string) => {
    let e = expr.trim();
    const lit = literal(e);
    if (lit.ok) return typeof lit.value === 'string' ? lit.value : JSON.stringify(lit.value);
    const before = e;
    e = e
      .replace(/\$\(\s*(['"])(.+?)\1\s*\)\.(?:item|first\(\)|last\(\)|all\(\)\[0\])\.json/g, (_m, _q, name) => `$node["${name}"].json`)
      .replace(/\$node\[\s*(['"])(.+?)\1\s*\]\.json/g, (_m, _q, name) => `$node["${name}"].json`)
      .replace(/^\$input\.(?:item|first\(\))\.json/, '$json');
    if (e !== before && /\.item\.json/.test(before)) {
      warn(`${where}: “${before}” now reads the FIRST item of that node (n8n used the matching item). Check it if the node handles several items.`);
    }
    try {
      parsePath(e);
    } catch {
      warn(`${where}: expression “{{ ${before} }}” uses JavaScript that is not supported here — rewrite it as a simple path or move the logic into a Code node.`);
      return whole;
    }
    return `{{ ${e} }}`;
  });
  return text;
}

function literal(expr: string): { ok: true; value: unknown } | { ok: false } {
  const t = expr.trim();
  if (t === 'true') return { ok: true, value: true };
  if (t === 'false') return { ok: true, value: false };
  if (t === 'null') return { ok: true, value: '' };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { ok: true, value: Number(t) };
  const q = t.match(/^(['"])(.*)\1$/s);
  if (q && !q[2].includes(q[1])) return { ok: true, value: q[2] };
  return { ok: false };
}

const OPS: Record<string, string> = {
  equals: 'equals', notEquals: 'notEquals', contains: 'contains', notContains: 'notContains',
  startsWith: 'startsWith', endsWith: 'endsWith', gt: 'greaterThan', gte: 'greaterThanOrEqual',
  lt: 'lessThan', lte: 'lessThanOrEqual', exists: 'isNotEmpty', notExists: 'isEmpty',
  empty: 'isEmpty', notEmpty: 'isNotEmpty', true: 'isTrue', false: 'isFalse',
  after: 'greaterThan', before: 'lessThan', afterOrEquals: 'greaterThanOrEqual', beforeOrEquals: 'lessThanOrEqual',
};

/** n8n "conditions" (IF v2 / Filter v2) → our conditions list. Returns null if not convertible. */
function convertConditions(p: any, cv: (v: unknown) => unknown): { conditions: any[]; combine: 'and' | 'or' } | null {
  const c = p?.conditions;
  if (!c || !Array.isArray(c.conditions)) return null;
  const out = [];
  for (const cond of c.conditions) {
    let op = OPS[cond?.operator?.operation];
    if (!op) return null;
    let right = cv(cond.rightValue);
    // "is equal to true" on a boolean → isTrue (and the same for false)
    if (cond?.operator?.type === 'boolean' && op === 'equals' && (right === true || right === 'true')) op = 'isTrue';
    else if (cond?.operator?.type === 'boolean' && op === 'equals' && (right === false || right === 'false')) op = 'isFalse';
    if (['isTrue', 'isFalse', 'isEmpty', 'isNotEmpty'].includes(op)) right = '';
    out.push({ left: cv(cond.leftValue), operator: op, right });
  }
  return { conditions: out, combine: c.combinator === 'or' ? 'or' : 'and' };
}

function scheduleFrom(p: any, timezone: string): { config: Record<string, unknown> } | null {
  const rule = p?.rule?.interval?.[0];
  if (!rule) return { config: { mode: 'cron', cron: '0 0 * * *', timezone } };
  const field = rule.field ?? 'days';
  const m = Number(rule.triggerAtMinute ?? 0);
  const h = Number(rule.triggerAtHour ?? 0);
  // Simple schedules become the beginner-friendly modes (time picker etc.); the rest stay cron.
  const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const simpleTime = Number.isInteger(h) && h >= 0 && h <= 23 && Number.isInteger(m) && m >= 0 && m <= 59;
  switch (field) {
    case 'cronExpression':
      return { config: { mode: 'cron', cron: String(rule.expression ?? '').trim().split(/\s+/).slice(-5).join(' '), timezone } };
    case 'minutes':
      return { config: { mode: 'interval', every: Number(rule.minutesInterval ?? 5), unit: 'minutes', timezone } };
    case 'hours':
      return { config: { mode: 'cron', cron: `${m} */${Number(rule.hoursInterval ?? 1)} * * *`, timezone } };
    case 'days': {
      const d = Number(rule.daysInterval ?? 1);
      if (d <= 1 && simpleTime) return { config: { mode: 'daily', time, timezone } };
      return { config: { mode: 'cron', cron: `${m} ${h} ${d > 1 ? `*/${d}` : '*'} * *`, timezone } };
    }
    case 'weeks': {
      const list = Array.isArray(rule.triggerAtDay) && rule.triggerAtDay.length ? rule.triggerAtDay : [1];
      const weekdays = list.map((x: unknown) => String(Number(x) % 7));
      if (simpleTime && Number(rule.weeksInterval ?? 1) <= 1 && weekdays.every((x: string) => /^[0-6]$/.test(x))) return { config: { mode: 'weekly', weekdays, time, timezone } };
      const days = list.join(',');
      return { config: { mode: 'cron', cron: `${m} ${h} * * ${days}`, timezone } };
    }
    case 'months': {
      const dom = Number(rule.triggerAtDayOfMonth ?? 1);
      if (simpleTime && Number(rule.monthsInterval ?? 1) <= 1 && Number.isInteger(dom) && dom >= 1 && dom <= 31) return { config: { mode: 'monthly', dayOfMonth: String(dom), time, timezone } };
      return { config: { mode: 'cron', cron: `${m} ${h} ${Number(rule.triggerAtDayOfMonth ?? 1)} * *`, timezone } };
    }
    default:
      return null;
  }
}

/** Wraps n8n Code-node JavaScript so it runs on our sandbox (items as plain objects). */
function wrapN8nCode(code: string, eachItem: boolean): string {
  if (eachItem) {
    return [
      '// Converted from n8n ("Run once for each item"). $json is the current item.',
      'const __out = [];',
      'for (const [__i, __j] of items.entries()) {',
      '  const $json = __j; const item = { json: __j }; const $itemIndex = __i;',
      '  const __r = await (async () => {',
      code,
      '  })();',
      '  if (__r !== undefined) __out.push(__r && typeof __r === "object" && "json" in __r ? __r.json : __r);',
      '}',
      'return __out;',
    ].join('\n');
  }
  return [
    '// Converted from n8n ("Run once for all items"): items look like n8n items ({ json }).',
    'const __items = items.map((json) => ({ json }));',
    'const $input = { all: () => __items, first: () => __items[0], last: () => __items[__items.length - 1] };',
    'const __r = await (async (items) => {',
    code,
    '})(__items);',
    'return (Array.isArray(__r) ? __r : [__r]).filter((r) => r !== undefined).map((r) => (r && typeof r === "object" && "json" in r ? r.json : r));',
  ].join('\n');
}

/** n8n "resource locator" values look like { __rl: true, mode, value, cachedResultName, cachedResultUrl }. */
function rl(v: any): { value: string; mode: string; name?: string; url?: string } {
  if (v && typeof v === 'object') return { value: String(v.value ?? ''), mode: String(v.mode ?? ''), name: v.cachedResultName, url: v.cachedResultUrl };
  return { value: String(v ?? ''), mode: '' };
}

/** n8n Google Sheets (v1–v4) → our Read Rows / Add Row / Update Row. */
function sheetsFrom(p: any, cv: (v: unknown, field: string) => unknown, warn: (m: string) => void, name: string): Converted | { unsupported: string } {
  const op = String(p.operation ?? 'read');
  if ((p.resource ?? 'sheet') !== 'sheet') return { unsupported: `Google Sheets “${p.resource}” operations are not supported yet` };

  const doc = rl(p.documentId ?? p.sheetId);
  const spreadsheet = doc.mode === 'url' || /^https?:/.test(doc.value) ? doc.value : doc.url ?? doc.value;
  const tab = rl(p.sheetName ?? p.range);
  let sheet = '';
  if (tab.name) sheet = tab.name;
  else if (tab.mode === 'name') sheet = tab.value;
  else if (/^\d+$/.test(tab.value)) sheet = `gid=${tab.value}`;
  else if (tab.mode === 'url') {
    const gid = /[#&?]gid=(\d+)/.exec(tab.value)?.[1];
    sheet = gid ? `gid=${gid}` : '';
  }
  else sheet = tab.value.replace(/!.*$/, ''); // v1–v3 "Sheet1!A:F"
  const location = {
    spreadsheet: String(cv(spreadsheet, 'Document') ?? ''),
    sheet: String(cv(sheet, 'Sheet') ?? ''),
    headerRow: Number(p.options?.dataLocationOnSheet?.values?.headerRow ?? p.options?.headerRow ?? 1) || 1,
  };
  if (/^=/.test(spreadsheet) || /^=/.test(sheet)) warn(`${name}: the document or sheet is chosen with an expression — check it after import.`);

  // Column values: v4 "columns.value" object, v3 "fieldsUi.fieldValues" list.
  const v4 = p.columns?.value && typeof p.columns.value === 'object' ? Object.entries(p.columns.value as Record<string, unknown>) : null;
  const v3 = Array.isArray(p.fieldsUi?.fieldValues) ? (p.fieldsUi.fieldValues as any[]).map((f) => [String(f.fieldId ?? f.column ?? ''), f.fieldValue] as [string, unknown]) : null;
  const pairs = (v4 ?? v3 ?? []).filter(([k]) => k);
  const autoMap = p.columns?.mappingMode === 'autoMapInputData' || (!v4 && !v3 && p.dataMode !== 'define');
  const kv = (list: [string, unknown][]) => list.map(([k, v]) => ({ key: k, value: cv(v, `Column ${k}`) }));

  switch (op) {
    case 'read':
    case 'lookup':
    case 'getAll': {
      const filters = Array.isArray(p.filtersUI?.values)
        ? (p.filtersUI.values as any[]).map((f) => ({ key: String(f.lookupColumn ?? ''), value: cv(f.lookupValue ?? '', 'Filter') }))
        : p.lookupColumn
          ? [{ key: String(p.lookupColumn), value: cv(p.lookupValue ?? '', 'Filter') }]
          : [];
      const first = p.options?.returnAllMatches === 'returnFirstMatch' || (op === 'lookup' && !p.options?.returnAllMatches);
      return { type: 'comm.sheetsRead', config: { ...location, filters, returnMode: first ? 'first' : 'all', valueMode: p.options?.outputFormatting?.values?.general === 'UNFORMATTED_VALUE' ? 'raw' : 'formatted' } };
    }
    case 'append':
      return { type: 'comm.sheetsCreateRow', config: { ...location, mode: autoMap ? 'all' : 'fields', columns: autoMap ? [] : kv(pairs), allowFormulas: false } };
    case 'update':
    case 'appendOrUpdate': {
      const matchColumn = String(p.columns?.matchingColumns?.[0] ?? p.columnToMatchOn ?? p.key ?? '');
      if (!matchColumn) return { unsupported: 'No “column to match on” was set in n8n' };
      if ((p.columns?.matchingColumns?.length ?? 0) > 1) warn(`${name}: only the first matching column (“${matchColumn}”) is used.`);
      const matchPair = pairs.find(([k]) => k === matchColumn);
      const matchValue = matchPair ? cv(matchPair[1], 'Match value') : cv(p.valueToMatchOn ?? `={{ $json["${matchColumn}"] }}`, 'Match value');
      return {
        type: 'comm.sheetsUpdateRow',
        config: {
          ...location,
          matchColumn,
          matchValue,
          mode: autoMap ? 'all' : 'fields',
          columns: autoMap ? [] : kv(pairs.filter(([k]) => k !== matchColumn)),
          ifNotFound: op === 'appendOrUpdate' ? 'add' : 'skip',
          multiple: 'first',
          allowFormulas: false,
        },
      };
    }
    default:
      return { unsupported: `Google Sheets operation “${op}” is not supported yet` };
  }
}

function convertNode(n: N8nNode, timezone: string, warn: (m: string) => void): Converted | { unsupported: string } {
  const p = n.parameters ?? {};
  const cv = (v: unknown, field: string) => convertValue(v, warn, `${n.name} › ${field}`);
  const t = n.type.replace(/^@n8n\/n8n-nodes-langchain\./, 'langchain.').replace(/^n8n-nodes-base\./, '');
  switch (t) {
    case 'manualTrigger':
      return { type: 'trigger.manual', config: {} };
    case 'scheduleTrigger':
    case 'cron': {
      const s = scheduleFrom(p, timezone);
      return s ? { type: 'trigger.schedule', config: s.config } : { unsupported: 'This schedule rule type has no equivalent' };
    }
    case 'webhook': {
      const method = String(p.httpMethod ?? 'GET').toUpperCase();
      const notes = ['n8n webhook URLs do not carry over: publish this workflow to get a new URL and update the caller.'];
      return { type: 'trigger.webhook', config: { method: ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method : 'POST', requireSignature: false }, notes };
    }
    case 'httpRequest': {
      const kv = (list: any) => (Array.isArray(list) ? list.map((x: any) => ({ key: String(x.name ?? ''), value: cv(x.value, 'parameter') })) : []);
      const body = p.sendBody ? (p.specifyBody === 'json' ? cv(p.jsonBody ?? '{}', 'body') : JSON.stringify(Object.fromEntries(kv(p.bodyParameters?.parameters).map((x: any) => [x.key, x.value])))) : '';
      const headers = kv(p.headerParameters?.parameters).filter((h: any) => !/^(authorization|proxy-authorization|cookie|x-api-key|api-key)$/i.test(h.key));
      if (p.authentication && p.authentication !== 'none') warn(`${n.name}: authentication was removed — connect it with a credential when that becomes available.`);
      return {
        type: 'data.httpRequest',
        config: {
          method: String(p.method ?? 'GET').toUpperCase(),
          url: cv(p.url ?? '', 'url'),
          query: p.sendQuery ? kv(p.queryParameters?.parameters) : [],
          headers: p.sendHeaders ? headers : [],
          bodyType: p.sendBody ? (p.specifyBody === 'json' || !p.contentType || p.contentType === 'json' ? 'json' : 'text') : 'none',
          body: typeof body === 'string' ? body : JSON.stringify(body),
          timeoutMs: Number(p.options?.timeout ?? 15000),
          failOnHttpError: true,
        },
      };
    }
    case 'if': {
      const c = convertConditions(p, (v) => cv(v, 'condition'));
      return c ? { type: 'logic.if', config: c, outputs: ['true', 'false'] } : { unsupported: 'Uses an IF condition type that cannot be converted' };
    }
    case 'filter': {
      const c = convertConditions(p, (v) => cv(v, 'condition'));
      return c ? { type: 'logic.filter', config: c } : { unsupported: 'Uses a filter condition type that cannot be converted' };
    }
    case 'switch': {
      const rules = p.rules?.values ?? [];
      const cases: any[] = [];
      let value: unknown = null;
      for (const [i, r] of rules.entries()) {
        const c = r?.conditions?.conditions;
        if (!Array.isArray(c) || c.length !== 1 || c[0]?.operator?.operation !== 'equals') return { unsupported: 'Only Switch rules of the form “value equals …” can be converted' };
        const left = cv(c[0].leftValue, 'rule');
        if (value !== null && JSON.stringify(left) !== JSON.stringify(value)) return { unsupported: 'Switch rules compare different values' };
        value = left;
        cases.push({ id: `c_${i + 1}`, label: String(r.outputKey ?? c[0].rightValue ?? `Case ${i + 1}`).slice(0, 60), value: cv(c[0].rightValue, 'rule') });
      }
      if (!cases.length) return { unsupported: 'Switch has no rules (or uses expression mode)' };
      const fallback = p.options?.fallbackOutput === 'extra' ? ['otherwise'] : [];
      return { type: 'logic.switch', config: { value, cases, caseSensitive: true }, outputs: [...cases.map((c) => c.id), ...fallback] };
    }
    case 'merge': {
      const mode = p.mode ?? 'append';
      if (mode === 'append') return { type: 'logic.merge', config: { mode: 'append' }, inputs: ['a', 'b'] };
      if (mode === 'combine' || mode === 'combineByFields' || mode === 'mergeByKey') {
        if (p.combineBy === 'combineByPosition' || p.combinationMode === 'mergeByPosition') return { type: 'logic.merge', config: { mode: 'byIndex' }, inputs: ['a', 'b'] };
        if (p.combineBy === 'combineAll') return { unsupported: 'Merge “all combinations” has no equivalent' };
        let pairs: { key: string; value: string }[] = [];
        if (Array.isArray(p.mergeByFields?.values)) pairs = p.mergeByFields.values.map((v: any) => ({ key: String(v.field1 ?? ''), value: String(v.field2 ?? '') }));
        else if (typeof p.fieldsToMatchString === 'string') {
          const names = [...new Set([...p.fieldsToMatchString.matchAll(/\[\s*'([^']+)'\s*\]|([^,\s][^,]*)/g)].map((m) => (m[1] ?? m[2] ?? '').trim().replace(/^\['|'\]$/g, '')).filter(Boolean))];
          pairs = names.map((f) => ({ key: f, value: f }));
        } else if (p.propertyName1) pairs = [{ key: String(p.propertyName1), value: String(p.propertyName2 ?? p.propertyName1) }];
        if (!pairs.length) return { unsupported: 'Merge by fields without field names' };
        const joinMode = p.joinMode ?? 'keepMatches';
        if (joinMode !== 'enrichInput1' && joinMode !== 'keepMatches') return { unsupported: `Merge join mode “${joinMode}” has no equivalent (only “keep matches” and “enrich input 1”)` };
        return { type: 'logic.merge', config: { mode: 'matchFields', fields: pairs, join: joinMode === 'enrichInput1' ? 'left' : 'inner' }, inputs: ['a', 'b'] };
      }
      return { unsupported: `Merge mode “${mode}” has no equivalent` };
    }
    case 'wait': {
      if (p.resume && p.resume !== 'timeInterval') return { unsupported: 'Only “wait for a time interval” can be converted' };
      return { type: 'logic.wait', config: { amount: Number(p.amount ?? 1), unit: ['seconds', 'minutes', 'hours'].includes(p.unit) ? p.unit : 'hours' } };
    }
    case 'splitOut':
      return { type: 'logic.loop', config: { mode: 'list', list: `{{ $json["${String(p.fieldToSplitOut ?? 'items')}"] }}`, itemKey: 'item', keepParent: p.include !== 'noOtherFields' } };
    case 'code': {
      if (p.language && p.language !== 'javaScript') return { unsupported: 'Only JavaScript Code nodes can be converted' };
      const code = String(p.jsCode ?? '');
      const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (/\$\(|\$node\b|\$env|\$vars|require\(|helpers\./.test(withoutComments)) warn(`${n.name}: the code uses n8n-only features ($('Node'), $env, require, helpers…). Check it after import.`);
      return { type: 'data.code', config: { code: wrapN8nCode(code, p.mode === 'runOnceForEachItem'), timeoutMs: 10000 } };
    }
    case 'gmail': {
      const op = p.operation ?? 'send';
      if (op === 'send' && (p.resource ?? 'message') === 'message') {
        if (p.options?.senderName) warn(`${n.name}: “Sender name” is not supported; mail is sent as the connected account.`);
        if (p.options?.attachmentsUi) warn(`${n.name}: attachments are not supported yet.`);
        return {
          type: 'comm.gmailSend',
          config: {
            to: cv(p.sendTo ?? '', 'To'),
            cc: cv(p.options?.ccList ?? '', 'Cc'),
            bcc: cv(p.options?.bccList ?? '', 'Bcc'),
            replyTo: cv(p.options?.replyTo ?? '', 'Reply-To'),
            subject: cv(p.subject ?? '', 'Subject'),
            format: p.emailType === 'text' ? 'text' : 'html',
            body: cv(p.message ?? '', 'Message'),
          },
        };
      }
      if (op === 'getAll') {
        return { type: 'comm.gmailRead', config: { query: cv(p.filters?.q ?? '', 'Search'), maxResults: Math.min(50, Number(p.limit ?? 10)), includeBody: !p.simple, markAsRead: false } };
      }
      return { unsupported: `Gmail operation “${op}” is not supported yet` };
    }
    case 'noOp':
      return { type: 'logic.filter', config: { conditions: [{ left: 'x', operator: 'isNotEmpty', right: '' }], combine: 'and' }, notes: ['“No operation” converted to a Filter that keeps everything.'] };
    case 'googleSheets':
      return sheetsFrom(p, cv, warn, n.name);
    default:
      return { unsupported: t.startsWith('langchain.') ? 'AI nodes arrive in Phase 3' : 'No equivalent node yet' };
  }
}

export function convertN8n(file: any): ImportResult {
  const report: ImportReport = { source: 'n8n', converted: [], unsupported: [], warnings: [], needsCredential: [] };
  const warn = (m: string) => report.warnings.push(m);
  const timezone = typeof file?.settings?.timezone === 'string' ? file.settings.timezone : 'Asia/Kuala_Lumpur';
  const n8nNodes: N8nNode[] = (file.nodes ?? []).filter((n: any) => n?.type && n.type !== 'n8n-nodes-base.stickyNote');
  if (!n8nNodes.length) throw new ImportError('The n8n file has no nodes');

  const nodes: WorkflowNode[] = [];
  const byName = new Map<string, { node: WorkflowNode; outputs: string[]; inputs: string[] }>();
  const triggerTypesSeen = new Set<string>();

  n8nNodes.forEach((n, i) => {
    const res = convertNode(n, timezone, warn);
    const id = safeId(n.id ?? '', i);
    // Our nodes are about twice as wide as n8n's, so spread the layout horizontally.
    const position = { x: Math.round((n.position?.[0] ?? i * 260) * 1.6), y: Math.round((n.position?.[1] ?? 0) * 1.1) };
    let node: WorkflowNode;
    let outputs: string[];
    let inputs: string[];
    if ('unsupported' in res) {
      // Count the outputs the n8n node had, so its connections can be kept.
      const outCount = Math.max(1, ...((file.connections?.[n.name]?.main as any[]) ?? [[]]).map((_: unknown, k: number) => k + 1));
      outputs = Array.from({ length: outCount }, (_, k) => (k === 0 ? 'main' : `out_${k}`));
      inputs = ['main'];
      node = {
        id,
        type: 'util.unsupported',
        name: n.name,
        position,
        config: {
          originalType: n.type,
          reason: res.unsupported,
          originalParameters: JSON.stringify(n.parameters ?? {}, null, 2).slice(0, 40000),
          outputs: outputs.map((o, k) => ({ id: o, label: outCount > 1 ? `output ${k + 1}` : '' })),
        },
      };
      report.unsupported.push({ name: n.name, type: n.type, reason: res.unsupported });
    } else {
      // Only one trigger of each type per workflow here.
      if (res.type.startsWith('trigger.') && triggerTypesSeen.has(res.type)) {
        report.unsupported.push({ name: n.name, type: n.type, reason: 'A second trigger of the same type is not allowed' });
        node = { id, type: 'util.unsupported', name: n.name, position, config: { originalType: n.type, reason: 'Second trigger of the same type', originalParameters: JSON.stringify(n.parameters ?? {}, null, 2), outputs: [{ id: 'main', label: '' }] } };
        outputs = ['main'];
        inputs = ['main'];
      } else {
        triggerTypesSeen.add(res.type);
        node = { id, type: res.type, name: n.name, position, config: res.config };
        outputs = res.outputs ?? ['main'];
        inputs = res.inputs ?? ['main'];
        report.converted.push({ name: n.name, from: n.type, to: res.type });
        res.notes?.forEach((m) => warn(`${n.name}: ${m}`));
      }
    }
    if (n.disabled) node.disabled = true;
    if (n.notes) node.notes = String(n.notes).slice(0, 2000);
    if (n.credentials && Object.keys(n.credentials).length && node.type !== 'util.unsupported') {
      node.credentialId = null;
      report.needsCredential.push(n.name);
    }
    nodes.push(node);
    byName.set(n.name, { node, outputs, inputs });
  });

  const connections: WorkflowConnection[] = [];
  for (const [sourceName, types] of Object.entries<any>(file.connections ?? {})) {
    const src = byName.get(sourceName);
    if (!src) continue;
    (types?.main ?? []).forEach((targets: any[] | null, outIndex: number) => {
      for (const t of targets ?? []) {
        const dst = byName.get(t?.node);
        if (!dst) continue;
        const sourceHandle = src.outputs[outIndex];
        if (!sourceHandle) {
          warn(`${sourceName}: output ${outIndex + 1} has no equivalent; its connection to “${t.node}” was dropped.`);
          continue;
        }
        const targetHandle = dst.inputs[Math.min(Number(t.index ?? 0), dst.inputs.length - 1)] ?? 'main';
        connections.push({ id: `e_${connections.length + 1}`, source: src.node.id, sourceHandle, target: dst.node.id, targetHandle });
      }
    });
  }
  if (file.active) warn('The n8n workflow was active. Imported workflows start inactive: publish and activate when ready.');

  return {
    name: String(file.name ?? 'Imported from n8n').slice(0, 120),
    description: `Imported from n8n${file.id ? ` (id ${file.id})` : ''}`,
    tags: ['imported', 'n8n'],
    definition: { schemaVersion: 1, nodes, connections, settings: {} },
    report,
  };
}
