import { z } from 'zod';
import type { Item } from '@widebed/shared';
import { defineNode, NodeError, requireService, type NodeExecutionContext } from '../types.js';

/**
 * Google Sheets nodes. They use the same Google account connection as Gmail
 * (it needs the "spreadsheets" permission — older connections must be reconnected).
 *
 * Beginner-friendly rules:
 *  - "Spreadsheet" accepts the normal browser link of the sheet (or just its ID).
 *  - Columns are found by the names in the header row (not letters), ignoring upper/lower case.
 *  - Each row comes out as one item, e.g. { "Name": "Ana", "Room": "A-12", "row_number": 5 }.
 */

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

type Ctx = NodeExecutionContext<any>;
interface Conn {
  accessToken: string;
  email: string | null;
}

/* ------------------------------------------------------------------ helpers */

/** Spreadsheet ID (and the tab id, if the link has one) from a link or a bare ID. */
export function parseSpreadsheet(input: unknown): { id: string; gid: string | null } {
  const s = String(input ?? '').trim();
  const url = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(s);
  const gid = /[#&?]gid=(\d+)/.exec(s);
  if (url) return { id: url[1]!, gid: gid ? gid[1]! : null };
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return { id: s, gid: null };
  throw new NodeError(s ? 'This is not a Google Sheets link. Open the sheet in your browser and copy the address bar.' : 'Paste the link of the Google Sheet', { code: 'SHEET_LINK' });
}

/** 0 → A, 25 → Z, 26 → AA */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** "'My tab'" — quoted the way the Sheets API expects. */
export function quoteTab(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/** Start row/column (1-based row, 0-based column) of an A1 range like "'Tab'!B3:F20". */
export function rangeStart(range: string): { row: number; col: number } {
  const cell = /!\$?([A-Z]+)\$?(\d+)/.exec(range ?? '');
  if (!cell) return { row: 1, col: 0 };
  let col = 0;
  for (const ch of cell[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(cell[2]), col: col - 1 };
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

/**
 * Value as it should be typed into a cell. Text that starts with = + - @ would be run
 * as a formula by Google Sheets, so it is written as plain text unless formulas are allowed.
 */
export function cellValue(v: unknown, allowFormulas: boolean): string | number | boolean {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (!allowFormulas && /^[=+\-@]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) return `'${s}`;
  return s;
}

async function connect(ctx: Ctx, credentialId = ctx.node.credentialId): Promise<Conn> {
  if (!credentialId) throw new NodeError('Choose a Google account for this node', { code: 'NO_CREDENTIAL' });
  const c = await requireService(ctx.services, 'googleToken', 'Google access')(credentialId);
  if (c.scopes && c.scopes.length && !c.scopes.includes(SHEETS_SCOPE)) {
    throw new NodeError('This Google connection has no Google Sheets access yet. Go to Credentials and click “Reconnect” on it.', { code: 'SHEETS_SCOPE' });
  }
  return c;
}

async function call(ctx: Ctx, conn: Conn, method: string, path: string, body?: unknown, what = 'the spreadsheet') {
  const res = await ctx.services.http.request({
    method,
    url: `${API}${path}`,
    headers: { authorization: `Bearer ${conn.accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: ctx.signal,
    timeoutMs: 30000,
  });
  let data: any = null;
  try {
    data = res.body ? JSON.parse(res.body) : null;
  } catch {
    data = res.body;
  }
  if (res.status < 400) return data;

  const msg = String(data?.error?.message ?? `HTTP ${res.status}`);
  const who = conn.email ?? 'the connected Google account';
  if (/insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(msg + JSON.stringify(data?.error?.details ?? ''))) {
    throw new NodeError('This Google connection has no Google Sheets access yet. Go to Credentials and click “Reconnect” on it.', { code: 'SHEETS_SCOPE' });
  }
  if (/has not been used in project|is disabled/i.test(msg)) {
    throw new NodeError('The Google Sheets API is switched off. In Google Cloud: APIs & Services → Library → “Google Sheets API” → Enable.', { code: 'SHEETS_API_OFF' });
  }
  if (res.status === 404) throw new NodeError(`Spreadsheet not found. Check the link, and that ${who} can open it.`, { code: 'SHEET_NOT_FOUND' });
  if (res.status === 403) throw new NodeError(`${who} cannot open ${what}. In Google Sheets click Share and add ${who}${method === 'GET' ? '' : ' as Editor'}.`, { code: 'SHEET_FORBIDDEN' });
  if (res.status === 400 && /Unable to parse range/i.test(msg)) throw new NodeError('That tab does not exist. Check the tab name at the bottom of the sheet.', { code: 'SHEET_TAB' });
  throw new NodeError(`Google Sheets: ${msg}`, { code: 'SHEETS_ERROR', retryable: res.status === 429 || res.status >= 500 });
}

/** Works out the tab title from the "Tab" field, the link's #gid, or the first tab. */
async function tabTitle(ctx: Ctx, conn: Conn, id: string, sheet: unknown, gidFromLink: string | null): Promise<string> {
  const s = String(sheet ?? '').trim();
  const gidField = /^gid=?(\d+)$/i.exec(s);
  if (s && !gidField) return s;
  const gid = gidField ? gidField[1]! : gidFromLink;
  const meta = await call(ctx, conn, 'GET', `/${encodeURIComponent(id)}?fields=sheets.properties(sheetId,title)`);
  const tabs: { sheetId: number; title: string }[] = (meta?.sheets ?? []).map((x: any) => x.properties);
  const tab = gid !== null ? tabs.find((t) => String(t.sheetId) === gid) : tabs[0];
  if (!tab) throw new NodeError('That tab does not exist any more. Type the tab name instead.', { code: 'SHEET_TAB' });
  return tab.title;
}

interface Table {
  id: string;
  title: string;
  headerRow: number;
  /** Column names, by column index (empty names are null). */
  headers: (string | null)[];
  /** Data rows: sheet row number + cell values by column index. */
  rows: { rowNumber: number; cells: unknown[] }[];
}

async function loadTable(ctx: Ctx, conn: Conn, cfg: { spreadsheet: unknown; sheet: unknown; headerRow: number }, raw = false): Promise<Table> {
  const { id, gid } = parseSpreadsheet(cfg.spreadsheet);
  const title = await tabTitle(ctx, conn, id, cfg.sheet, gid);
  const render = raw ? 'UNFORMATTED_VALUE' : 'FORMATTED_VALUE';
  const data = await call(ctx, conn, 'GET', `/${encodeURIComponent(id)}/values/${encodeURIComponent(quoteTab(title))}?majorDimension=ROWS&valueRenderOption=${render}&dateTimeRenderOption=FORMATTED_STRING`);
  const start = rangeStart(String(data?.range ?? ''));
  const grid: unknown[][] = (data?.values ?? []).map((r: unknown[]) => [...Array(start.col).fill(''), ...r]);
  const headerIndex = cfg.headerRow - start.row;
  const headerCells = headerIndex >= 0 ? grid[headerIndex] ?? [] : [];
  const seen = new Map<string, number>();
  const headers = headerCells.map((h) => {
    const name = String(h ?? '').trim();
    if (!name) return null;
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    return n === 1 ? name : `${name}_${n}`;
  });
  if (!headers.some(Boolean)) throw new NodeError(`Row ${cfg.headerRow} of “${title}” is empty. It should contain the column names (e.g. Name, Email, Room).`, { code: 'SHEET_NO_HEADER' });
  const rows = grid
    .map((cells, i) => ({ rowNumber: start.row + i, cells }))
    .filter((r) => r.rowNumber > cfg.headerRow && r.cells.some((c) => String(c ?? '').trim() !== ''));
  return { id, title, headerRow: cfg.headerRow, headers, rows };
}

function rowObject(t: Table, cells: unknown[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  t.headers.forEach((h, i) => {
    if (h) o[h] = cells[i] ?? '';
  });
  return o;
}

function columnIndex(t: Table, name: string): number {
  const i = t.headers.findIndex((h) => h !== null && norm(h) === norm(name));
  if (i < 0) {
    const list = t.headers.filter(Boolean).join(', ');
    throw new NodeError(`Column “${name}” is not in the header row of “${t.title}”. Columns are: ${list}`, { code: 'SHEET_COLUMN' });
  }
  return i;
}

/** Column → value pairs to write, either from the "Columns" list or from all matching item fields. */
function valuesToWrite(t: Table, c: any, item: Item, ignoreUnknown: boolean): Map<number, unknown> {
  const out = new Map<number, unknown>();
  if (c.mode === 'all') {
    for (const [k, v] of Object.entries(item.json)) {
      const i = t.headers.findIndex((h) => h !== null && norm(h) === norm(k));
      if (i >= 0) out.set(i, v);
    }
    return out;
  }
  for (const { key, value } of (c.columns ?? []) as { key: string; value: unknown }[]) {
    if (!String(key ?? '').trim()) continue;
    if (ignoreUnknown && !t.headers.some((h) => h !== null && norm(h) === norm(key))) continue;
    out.set(columnIndex(t, key), value);
  }
  return out;
}

const withRow = (o: Record<string, unknown>, rowNumber: number) => ({ ...o, row_number: rowNumber });

/** Cache tables per run of a node so a list of items reads the sheet once. */
function tableCache() {
  const m = new Map<string, Promise<Table>>();
  return (ctx: Ctx, conn: Conn, cfg: { spreadsheet: unknown; sheet: unknown; headerRow: number }, raw = false) => {
    const key = JSON.stringify([cfg.spreadsheet, cfg.sheet, cfg.headerRow, raw]);
    if (!m.has(key)) m.set(key, loadTable(ctx, conn, cfg, raw));
    return m.get(key)!;
  };
}

/**
 * Reads a whole tab as row objects, for other nodes (e.g. the AI Chatbot's look-ups).
 * `credentialId` is a Google account connection.
 */
export async function readSheetRows(ctx: NodeExecutionContext<any>, credentialId: string, cfg: { spreadsheet: unknown; sheet: unknown; headerRow?: number }) {
  const conn = await connect(ctx, credentialId);
  const t = await loadTable(ctx, conn, { spreadsheet: cfg.spreadsheet, sheet: cfg.sheet, headerRow: cfg.headerRow ?? 1 });
  return { title: t.title, columns: t.headers.filter((h): h is string => !!h), rows: t.rows.map((r) => withRow(rowObject(t, r.cells), r.rowNumber)) };
}

/* ------------------------------------------------------------- shared fields */

const LOCATION_FIELDS = [
  {
    key: 'spreadsheet',
    label: 'Spreadsheet link',
    type: 'string' as const,
    required: true,
    expressions: true,
    placeholder: 'https://docs.google.com/spreadsheets/d/…/edit#gid=0',
    help: 'Open the sheet in your browser and copy the address bar. The Google account of this node must be able to open it.',
  },
  {
    key: 'sheet',
    label: 'Tab name',
    type: 'string' as const,
    expressions: true,
    placeholder: 'Sheet1',
    help: 'The tab at the bottom of the sheet. Leave empty to use the tab in the link (or the first tab).',
  },
];
const HEADER_ROW_FIELD = { key: 'headerRow', label: 'Column names are in row', type: 'number' as const, default: 1, help: 'Usually 1. Rows below it are the data.' };
const location = {
  spreadsheet: z.string({ required_error: 'Paste the link of the Google Sheet' }).min(1, 'Paste the link of the Google Sheet'),
  sheet: z.string().default(''),
  headerRow: z.coerce.number().int().min(1).max(1000).default(1),
};
const keyValue = z.array(z.object({ key: z.string(), value: z.unknown() })).default([]);

/* ---------------------------------------------------------------- Read Rows */

export const sheetsRead = defineNode({
  descriptor: {
    type: 'comm.sheetsRead',
    version: 1,
    displayName: 'Google Sheets Read Rows',
    description: 'Read rows from a Google Sheet. Each row becomes one item.',
    category: 'communication',
    icon: 'sheet',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    credentialProvider: 'google_oauth',
    fields: [
      ...LOCATION_FIELDS,
      { key: 'filters', label: 'Only rows where (optional)', type: 'keyValue', expressions: true, default: [], keyPlaceholder: 'Column', valuePlaceholder: 'equals this value', help: 'Leave empty to read every row. With several lines, a row must match all of them. Upper/lower case is ignored.' },
      {
        key: 'returnMode',
        label: 'Return',
        type: 'select',
        default: 'all',
        options: [
          { label: 'All matching rows', value: 'all' },
          { label: 'Only the first matching row', value: 'first' },
        ],
      },
      HEADER_ROW_FIELD,
      {
        key: 'valueMode',
        label: 'Values',
        type: 'select',
        default: 'formatted',
        options: [
          { label: 'As shown in the sheet (e.g. “RM 1,200.00”, “14/11/2026”)', value: 'formatted' },
          { label: 'Raw values (e.g. 1200, dates as numbers)', value: 'raw' },
        ],
      },
    ],
    inputSchema: { description: 'Any items. The sheet is read once per item (filters can use {{ }} data from the item).' },
    outputSchema: {
      description: 'One item per row, with the column names as fields and the sheet row number.',
      example: [{ json: { Name: 'Ana Lee', Email: 'ana@example.com', Room: 'A-12', 'Rent Due': '25/11/2026', row_number: 2 } }],
    },
    retryable: true,
    available: true,
    docs: [
      '### Google Sheets Read Rows',
      'Reads a tab of a Google Sheet. **Row 1 must contain the column names** (change *Column names are in row* if not).',
      'Every row below becomes one item, so the next node runs once per row — e.g. one email per tenant.',
      '',
      '**Example** — tenants whose rent is due:',
      '- Spreadsheet link: the link of your “Tenants” sheet',
      '- Only rows where: `Status` = `Unpaid`',
      '- Next node: Gmail Send Email, To: `{{ $json.Email }}`',
      '',
      'Empty rows are skipped. Share the sheet with the Google account of this node (Viewer is enough).',
    ].join('\n'),
  },
  configSchema: z.object({
    ...location,
    filters: keyValue,
    returnMode: z.enum(['all', 'first']).default('all'),
    valueMode: z.enum(['formatted', 'raw']).default('formatted'),
  }),
  async execute(ctx) {
    const conn = await connect(ctx);
    const table = tableCache();
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const c = ctx.resolve(ctx.config, ctx.items[i], i) as any;
      const t = await table(ctx, conn, c, c.valueMode === 'raw');
      const filters = ((c.filters ?? []) as { key: string; value: unknown }[])
        .filter((f) => String(f.key ?? '').trim())
        .map((f) => ({ col: columnIndex(t, f.key), value: norm(f.value) }));
      const matches = t.rows.filter((r) => filters.every((f) => norm(r.cells[f.col]) === f.value));
      for (const r of c.returnMode === 'first' ? matches.slice(0, 1) : matches) out.push({ json: withRow(rowObject(t, r.cells), r.rowNumber) });
    }
    return { outputs: { main: out } };
  },
});

/* ------------------------------------------------------------------ Add Row */

const WRITE_FIELDS = [
  {
    key: 'mode',
    label: 'What to write',
    type: 'select' as const,
    default: 'fields',
    options: [
      { label: 'Choose the columns below', value: 'fields' },
      { label: 'All fields of the item whose names match a column', value: 'all' },
    ],
  },
  { key: 'columns', label: 'Columns', type: 'keyValue' as const, expressions: true, default: [], keyPlaceholder: 'Column name', valuePlaceholder: 'Value, e.g. {{ $json.email }}', showIf: { key: 'mode', equals: ['fields'] } },
];
const ALLOW_FORMULAS_FIELD = { key: 'allowFormulas', label: 'Allow formulas (values starting with =)', type: 'boolean' as const, default: false, help: 'Off: such values are written as plain text, which is safer for data that comes from guests or other systems.' };

export const sheetsCreateRow = defineNode({
  descriptor: {
    type: 'comm.sheetsCreateRow',
    version: 1,
    displayName: 'Google Sheets Add Row',
    description: 'Add a new row at the bottom of a Google Sheet for each item.',
    category: 'communication',
    icon: 'sheet',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    credentialProvider: 'google_oauth',
    fields: [...LOCATION_FIELDS, ...WRITE_FIELDS, HEADER_ROW_FIELD, ALLOW_FORMULAS_FIELD],
    inputSchema: { description: 'One new row is added per item.' },
    outputSchema: { description: 'The row that was added, with its row number.', example: [{ json: { Name: 'Ana Lee', Email: 'ana@example.com', row_number: 15 } }] },
    retryable: false,
    available: true,
    docs: [
      '### Google Sheets Add Row',
      'Adds one row per item under the last row of the table. Columns are matched **by name** (upper/lower case ignored), so the column order in the sheet does not matter.',
      '',
      '**Example** — log every new booking:',
      '- Columns: `Booking ID` = `{{ $json.bookingId }}`, `Guest` = `{{ $json.guestName }}`, `Nights` = `{{ $json.nights }}`',
      '',
      'Values are entered as if typed, so “25/11/2026” becomes a date and “120” a number.',
      'Automatic retry is off so the same row is never added twice. Share the sheet with the Google account as **Editor**.',
    ].join('\n'),
  },
  configSchema: z.object({
    ...location,
    mode: z.enum(['fields', 'all']).default('fields'),
    columns: keyValue,
    allowFormulas: z.boolean().default(false),
  }),
  async execute(ctx) {
    if (!ctx.items.length) return { outputs: { main: [] } };
    const conn = await connect(ctx);
    const table = tableCache();
    // Group items by target (normally all items go to the same tab).
    const groups = new Map<string, { t: Table; rows: unknown[][]; objects: Record<string, unknown>[]; allowFormulas: boolean }>();
    for (let i = 0; i < ctx.items.length; i++) {
      const c = ctx.resolve(ctx.config, ctx.items[i], i) as any;
      const t = await table(ctx, conn, c);
      const values = valuesToWrite(t, c, ctx.items[i]!, false);
      if (!values.size) throw new NodeError(c.mode === 'all' ? 'None of the item’s fields match a column name in the sheet' : 'Add at least one column to write', { code: 'SHEET_NOTHING' });
      const width = t.headers.length;
      const row = Array.from({ length: width }, (_, k) => (values.has(k) ? cellValue(values.get(k), c.allowFormulas) : null));
      const key = `${t.id}|${t.title}|${t.headerRow}`;
      if (!groups.has(key)) groups.set(key, { t, rows: [], objects: [], allowFormulas: c.allowFormulas });
      const g = groups.get(key)!;
      g.rows.push(row);
      g.objects.push(Object.fromEntries([...values].map(([k, v]) => [t.headers[k]!, v])));
    }
    const out: Item[] = [];
    for (const { t, rows, objects } of groups.values()) {
      const range = `${quoteTab(t.title)}!A${t.headerRow}:${columnLetter(t.headers.length - 1)}${t.headerRow}`;
      const res = await call(ctx, conn, 'POST', `/${encodeURIComponent(t.id)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS&includeValuesInResponse=false`, { majorDimension: 'ROWS', values: rows }, 'this spreadsheet');
      const first = rangeStart(String(res?.updates?.updatedRange ?? '')).row;
      objects.forEach((o, k) => out.push({ json: withRow(o, first + k) }));
    }
    return { outputs: { main: out } };
  },
});

/* --------------------------------------------------------------- Update Row */

export const sheetsUpdateRow = defineNode({
  descriptor: {
    type: 'comm.sheetsUpdateRow',
    version: 1,
    displayName: 'Google Sheets Update Row',
    description: 'Find a row by a column value (e.g. Booking ID) and change some of its cells.',
    category: 'communication',
    icon: 'sheet',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    credentialProvider: 'google_oauth',
    fields: [
      ...LOCATION_FIELDS,
      { key: 'matchColumn', label: 'Find the row where column', type: 'string', required: true, placeholder: 'Booking ID', help: 'A column with a unique value per row works best, e.g. an ID or email.' },
      { key: 'matchValue', label: 'equals', type: 'string', required: true, expressions: true, placeholder: '{{ $json.bookingId }}' },
      ...WRITE_FIELDS.map((f) => (f.key === 'columns' ? { ...f, label: 'Change these columns' } : f)),
      {
        key: 'ifNotFound',
        label: 'If no row is found',
        type: 'select',
        default: 'skip',
        options: [
          { label: 'Skip it (do nothing)', value: 'skip' },
          { label: 'Add it as a new row', value: 'add' },
          { label: 'Stop with an error', value: 'error' },
        ],
      },
      {
        key: 'multiple',
        label: 'If several rows match',
        type: 'select',
        default: 'first',
        options: [
          { label: 'Update only the first one', value: 'first' },
          { label: 'Update all of them', value: 'all' },
        ],
      },
      HEADER_ROW_FIELD,
      ALLOW_FORMULAS_FIELD,
    ],
    inputSchema: { description: 'One lookup + update per item.' },
    outputSchema: {
      description: 'One item per updated (or added) row: the whole row after the change, its row number and what happened.',
      example: [{ json: { 'Booking ID': 'B-102', Status: 'Paid', row_number: 7, action: 'updated' } }],
    },
    retryable: false,
    available: true,
    docs: [
      '### Google Sheets Update Row',
      'Finds rows where a column equals a value, then changes only the columns you list. Other cells stay as they are.',
      '',
      '**Example** — mark a booking as paid:',
      '- Find the row where column `Booking ID` equals `{{ $json.bookingId }}`',
      '- Change these columns: `Status` = `Paid`, `Paid on` = `{{ $json.paidAt }}`',
      '',
      '*If no row is found*: skip, add a new row (“update or add”), or stop with an error. Skipped items are not passed on.',
      'Matching ignores upper/lower case and spaces at the ends. Share the sheet with the Google account as **Editor**.',
    ].join('\n'),
  },
  configSchema: z.object({
    ...location,
    matchColumn: z.string({ required_error: 'Type the column to search in (e.g. Booking ID)' }).min(1, 'Type the column to search in (e.g. Booking ID)'),
    matchValue: z.unknown().refine((v) => v !== undefined && String(v).trim() !== '', 'Enter the value to look for'),
    mode: z.enum(['fields', 'all']).default('fields'),
    columns: keyValue,
    ifNotFound: z.enum(['skip', 'add', 'error']).default('skip'),
    multiple: z.enum(['first', 'all']).default('first'),
    allowFormulas: z.boolean().default(false),
  }),
  async execute(ctx) {
    if (!ctx.items.length) return { outputs: { main: [] } };
    const conn = await connect(ctx);
    const table = tableCache();
    const writes = new Map<string, { t: Table; cells: { range: string; values: unknown[][] }[]; appends: unknown[][] }>();
    const out: Item[] = [];

    for (let i = 0; i < ctx.items.length; i++) {
      const c = ctx.resolve(ctx.config, ctx.items[i], i) as any;
      const t = await table(ctx, conn, c);
      const key = `${t.id}|${t.title}|${t.headerRow}`;
      if (!writes.has(key)) writes.set(key, { t, cells: [], appends: [] });
      const w = writes.get(key)!;
      const matchCol = columnIndex(t, c.matchColumn);
      const wanted = norm(c.matchValue);
      // "All fields" mode: the match column itself is not rewritten.
      const values = valuesToWrite(t, c, ctx.items[i]!, false);
      if (c.mode === 'all') values.delete(matchCol);
      if (!values.size && c.ifNotFound !== 'add') throw new NodeError(c.mode === 'all' ? 'None of the item’s fields match a column name in the sheet' : 'Add at least one column to change', { code: 'SHEET_NOTHING' });

      let found = t.rows.filter((r) => norm(r.cells[matchCol]) === wanted);
      if (c.multiple === 'first') found = found.slice(0, 1);

      if (!found.length) {
        if (c.ifNotFound === 'error') throw new NodeError(`No row where “${t.headers[matchCol]}” is “${c.matchValue}”`, { code: 'SHEET_ROW_NOT_FOUND' });
        if (c.ifNotFound === 'add') {
          values.set(matchCol, c.matchValue);
          const row = Array.from({ length: t.headers.length }, (_, k) => (values.has(k) ? cellValue(values.get(k), c.allowFormulas) : null));
          w.appends.push(row);
          // Remember it so a later item with the same value updates instead of adding again.
          t.rows.push({ rowNumber: -1, cells: row });
        }
        continue;
      }

      for (const r of found) {
        for (const [col, v] of values) {
          const cell = cellValue(v, c.allowFormulas);
          r.cells[col] = cell;
          if (r.rowNumber > 0) w.cells.push({ range: `${quoteTab(t.title)}!${columnLetter(col)}${r.rowNumber}`, values: [[cell]] });
        }
        if (r.rowNumber > 0) out.push({ json: { ...rowObject(t, r.cells), row_number: r.rowNumber, action: 'updated' } });
      }
    }

    for (const { t, cells, appends } of writes.values()) {
      if (cells.length) {
        await call(ctx, conn, 'POST', `/${encodeURIComponent(t.id)}/values:batchUpdate`, { valueInputOption: 'USER_ENTERED', data: cells }, 'this spreadsheet');
      }
      if (appends.length) {
        const range = `${quoteTab(t.title)}!A${t.headerRow}:${columnLetter(t.headers.length - 1)}${t.headerRow}`;
        const res = await call(ctx, conn, 'POST', `/${encodeURIComponent(t.id)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { majorDimension: 'ROWS', values: appends }, 'this spreadsheet');
        const first = rangeStart(String(res?.updates?.updatedRange ?? '')).row;
        appends.forEach((row, k) => out.push({ json: { ...rowObject(t, row.map((v) => v ?? '')), row_number: first + k, action: 'added' } }));
      }
    }
    return { outputs: { main: out } };
  },
});
