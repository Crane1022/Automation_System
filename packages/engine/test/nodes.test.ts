import { describe, expect, it } from 'vitest';
import { describeSchedule, oncePassed, parseDay, scheduleCron, todayInfo, type WorkflowDefinition, type WorkflowNode } from '@widebed/shared';
import { buildMime, cellValue, columnLetter, createDefaultRegistry, evaluateCondition, extractBody, nextScheduleCheck, parseAiJson, parseSpreadsheet, type NodeServices } from './helpers.js';
import { resolveValue, runWorkflow, validateWorkflow } from '../src/index.js';

const registry = createDefaultRegistry();
const noHttp = { request: async () => { throw new Error('no network in tests'); } };

const node = (id: string, type: string, config: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, type, name: id, position: { x: 0, y: 0 }, config, ...extra });
const edge = (source: string, target: string, sourceHandle = 'main', targetHandle = 'main') => ({ id: `${source}-${target}-${sourceHandle}`, source, sourceHandle, target, targetHandle });

async function run(def: WorkflowDefinition, items: unknown[], services: Partial<NodeServices> = {}) {
  return runWorkflow({
    executionId: 'e', workflowId: 'w', definition: def, registry,
    services: { http: noHttp, ...services } as NodeServices,
    triggerItems: items.map((json) => ({ json: json as Record<string, unknown> })),
  });
}

describe('Switch', () => {
  const def: WorkflowDefinition = {
    schemaVersion: 1,
    nodes: [
      node('t', 'trigger.manual'),
      node('sw', 'logic.switch', { value: '{{ $json.status }}', cases: [{ id: 'c_a', label: 'Confirmed', value: 'confirmed' }, { id: 'c_b', label: 'Cancelled', value: 'cancelled' }] }),
      node('a', 'logic.filter', { conditions: [{ left: 1, operator: 'equals', right: 1 }] }),
      node('o', 'logic.filter', { conditions: [{ left: 1, operator: 'equals', right: 1 }] }),
    ],
    connections: [edge('t', 'sw'), edge('sw', 'a', 'c_a'), edge('sw', 'o', 'otherwise')],
  };
  it('routes items to the first matching case or otherwise (case-insensitive by default)', async () => {
    const r = await run(def, [{ status: 'CONFIRMED' }, { status: 'cancelled' }, { status: 'pending' }]);
    expect(r.status).toBe('success');
    expect(r.outputs.sw.c_a).toHaveLength(1);
    expect(r.outputs.sw.c_b).toHaveLength(1);
    expect(r.outputs.sw.otherwise).toEqual([{ json: { status: 'pending' } }]);
  });
  it('rejects connections from a deleted case', () => {
    const broken = structuredClone(def);
    broken.connections.push(edge('sw', 'o', 'c_gone'));
    expect(validateWorkflow(broken, registry).map((i) => i.message).join()).toMatch(/no output "c_gone"/);
  });
});

describe('Filter, Loop and Merge', () => {
  it('filters, splits lists into items and merges two branches', async () => {
    const def: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        node('t', 'trigger.manual'),
        node('f', 'logic.filter', { conditions: [{ left: '{{ $json.active }}', operator: 'isTrue' }] }),
        node('l', 'logic.loop', { mode: 'list', list: '{{ $json.rooms }}', itemKey: 'room', keepParent: false }),
        node('c', 'logic.loop', { mode: 'count', count: 2 }),
        node('m', 'logic.merge', { mode: 'append' }),
      ],
      connections: [edge('t', 'f'), edge('f', 'l'), edge('t', 'c'), edge('l', 'm', 'main', 'a'), edge('c', 'm', 'main', 'b')],
    };
    const r = await run(def, [{ active: true, rooms: ['12A', '12B'] }, { active: false, rooms: ['9C'] }]);
    expect(r.status).toBe('success');
    expect(r.outputs.l.main.map((i) => i.json)).toEqual([{ index: 0, room: '12A' }, { index: 1, room: '12B' }]);
    expect(r.outputs.c.main).toHaveLength(4); // 2 input items × 2
    expect(r.outputs.m.main).toHaveLength(6); // merge waits for both branches
  });

  it('combines by position', async () => {
    const def: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [node('t', 'trigger.manual'), node('a', 'logic.loop', { mode: 'count', count: 1 }), node('m', 'logic.merge', { mode: 'byIndex' })],
      connections: [edge('t', 'a'), edge('t', 'm', 'main', 'a'), edge('a', 'm', 'main', 'b')],
    };
    const r = await run(def, [{ x: 1 }]);
    expect(r.outputs.m.main).toEqual([{ json: { x: 1, index: 0 } }]);
  });

  it('fails clearly when a loop list is not an array', async () => {
    const def: WorkflowDefinition = { schemaVersion: 1, nodes: [node('t', 'trigger.manual'), node('l', 'logic.loop', { mode: 'list', list: '{{ $json.x }}' })], connections: [edge('t', 'l')] };
    const r = await run(def, [{ x: 'nope' }]);
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('NOT_A_LIST');
  });
});

describe('Wait and Code use platform services', () => {
  it('waits through the wait service and fails clearly without it', async () => {
    const def: WorkflowDefinition = { schemaVersion: 1, nodes: [node('t', 'trigger.manual'), node('w', 'logic.wait', { amount: 2, unit: 'minutes' })], connections: [edge('t', 'w')] };
    const waited: number[] = [];
    const ok = await run(def, [{}], { wait: async (ms) => void waited.push(ms) });
    expect(ok.status).toBe('success');
    expect(waited).toEqual([120000]);
    const missing = await run(def, [{}]);
    expect(missing.error?.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('turns code results into items and rejects non-objects', async () => {
    const def = (code: string): WorkflowDefinition => ({ schemaVersion: 1, nodes: [node('t', 'trigger.manual'), node('c', 'data.code', { code })], connections: [edge('t', 'c')] });
    const runCode = async (_code: string, input: unknown) => (_code.includes('bad') ? [1] : (input as any[]).map((i) => ({ ...i, ok: true })));
    expect((await run(def('good'), [{ a: 1 }], { runCode })).outputs.c.main).toEqual([{ json: { a: 1, ok: true } }]);
    expect((await run(def('bad'), [{ a: 1 }], { runCode })).error?.code).toBe('BAD_RETURN');
  });
});

describe('Schedule and event triggers', () => {
  it('validates cron expressions and time zones', () => {
    const bad = registry.validateNodeConfig(node('s', 'trigger.schedule', { mode: 'cron', cron: '61 * * * *', timezone: 'Mars/Base' }));
    expect(bad.map((i) => i.message).join()).toMatch(/time zone/);
    expect(bad.map((i) => i.message).join()).toMatch(/cron/i);
    expect(registry.validateNodeConfig(node('s', 'trigger.schedule', { mode: 'cron', cron: '0 9 * * 1-5', timezone: 'Asia/Kuala_Lumpur' }))).toEqual([]);
  });
  it('computes the next cron time in the configured time zone', () => {
    // 09:00 in Kuala Lumpur (UTC+8) = 01:00 UTC
    const next = nextScheduleCheck({ mode: 'cron', cron: '0 9 * * *', timezone: 'Asia/Kuala_Lumpur', every: 1, unit: 'minutes' }, Date.parse('2026-11-13T05:00:00Z'));
    expect(new Date(next).toISOString()).toBe('2026-11-14T01:00:00.000Z');
  });
  it('validates the beginner-friendly schedule options', () => {
    const v = (cfg: Record<string, unknown>) => registry.validateNodeConfig(node('s', 'trigger.schedule', { timezone: 'Asia/Kuala_Lumpur', ...cfg })).map((i) => i.message).join();
    expect(v({ mode: 'once', date: '2026-11-14', time: '14:00' })).toBe('');
    expect(v({ mode: 'once', date: '', time: '14:00' })).toMatch(/date/);
    expect(v({ mode: 'once', date: '2026-02-30', time: '14:00' })).toMatch(/date/);
    expect(v({ mode: 'daily', time: '25:00' })).toMatch(/time/);
    expect(v({ mode: 'weekly', weekdays: [], time: '09:00' })).toMatch(/day/);
    expect(v({ mode: 'weekly', weekdays: ['1', '5'], time: '09:00' })).toBe('');
    expect(v({ mode: 'monthly', dayOfMonth: 'L', time: '09:00' })).toBe('');
    expect(v({ mode: 'monthly', dayOfMonth: '32', time: '09:00' })).toMatch(/day of the month/);
  });
  it('turns simple schedules into cron patterns and plain English', () => {
    expect(scheduleCron({ mode: 'once', date: '2026-11-14', time: '14:00' })).toBe('0 14 14 11 *');
    expect(scheduleCron({ mode: 'daily', time: '08:30' })).toBe('30 8 * * *');
    expect(scheduleCron({ mode: 'weekly', weekdays: ['5', '1'], time: '09:00' })).toBe('0 9 * * 1,5');
    expect(scheduleCron({ mode: 'monthly', dayOfMonth: 'L', time: '18:00' })).toBe('0 18 L * *');
    expect(describeSchedule({ mode: 'once', date: '2026-11-14', time: '14:00' })).toBe('Once, on 14 Nov 2026 at 2:00 PM');
    expect(describeSchedule({ mode: 'weekly', weekdays: ['1', '2', '3', '4', '5'], time: '09:00' })).toBe('Every weekday (Mon–Fri) at 9:00 AM');
    expect(describeSchedule({ mode: 'weekly', weekdays: ['0', '1', '5'], time: '00:15' })).toBe('Every Monday, Friday and Sunday at 12:15 AM');
    expect(describeSchedule({ mode: 'monthly', dayOfMonth: '1', time: '12:00' })).toBe('On the 1st of every month at 12:00 PM');
    // 14 Nov 2026 2:00 PM in Kuala Lumpur = 06:00 UTC
    expect(oncePassed({ mode: 'once', date: '2026-11-14', time: '14:00', timezone: 'Asia/Kuala_Lumpur' }, new Date('2026-11-14T05:59:00Z'))).toBe(false);
    expect(oncePassed({ mode: 'once', date: '2026-11-14', time: '14:00', timezone: 'Asia/Kuala_Lumpur' }, new Date('2026-11-14T06:00:00Z'))).toBe(true);
  });
  it('rejects invalid event names', () => {
    expect(registry.validateNodeConfig(node('e', 'trigger.event', { eventName: 'Booking Created!' }))).not.toEqual([]);
    expect(registry.validateNodeConfig(node('e', 'trigger.event', { eventName: 'booking.created' }))).toEqual([]);
  });
});

describe('Firebase nodes', () => {
  it('require a connection and go through the restricted Firestore service', async () => {
    const def = (extra: Partial<WorkflowNode>): WorkflowDefinition => ({
      schemaVersion: 1,
      nodes: [node('t', 'trigger.manual'), node('r', 'data.firebaseRead', { mode: 'query', collection: 'bookings', where: [{ field: 'nights', op: '>=', value: '2' }], limit: 5 }, extra)],
      connections: [edge('t', 'r')],
    });
    expect(validateWorkflow(def({}), registry).map((i) => i.message).join()).toMatch(/choose a connection/);
    const calls: any[] = [];
    const firestore = async () => ({
      query: async (col: string, opts: any) => (calls.push([col, opts]), [{ id: 'B1', path: 'bookings/B1', data: { nights: 3 } }]),
    }) as any;
    const r = await run(def({ credentialId: 'cred_1' }), [{}], { firestore });
    expect(r.status).toBe('success');
    expect(calls[0][1].where[0].value).toBe(2); // "2" typed in the UI becomes a number
    expect(r.outputs.r.main[0].json).toEqual({ id: 'B1', path: 'bookings/B1', nights: 3 });
  });
});

describe('Gmail helpers', () => {
  it('builds a UTF-8 MIME message and blocks header injection', () => {
    const mime = buildMime({ from: 'a@x.com', to: 'b@y.com', subject: 'Selamat datang 🎉', body: 'Hello', html: false });
    expect(mime).toContain('Subject: =?UTF-8?B?');
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
  });
  it('sends one email per item through the Gmail API', async () => {
    const sent: any[] = [];
    const http = {
      request: async (req: any) => {
        sent.push(req);
        return { status: 200, statusText: 'OK', headers: {}, url: req.url, body: JSON.stringify({ id: 'm1', threadId: 't1' }) };
      },
    };
    const def: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [node('t', 'trigger.manual'), node('g', 'comm.gmailSend', { to: '{{ $json.email }}', subject: 'Hi {{ $json.name }}', body: 'Welcome' }, { credentialId: 'cred_g' })],
      connections: [edge('t', 'g')],
    };
    const r = await run(def, [{ email: 'ana@example.com', name: 'Ana' }, { email: 'evil@example.com\r\nBcc: all@x.com', name: 'X' }], {
      http: http as any,
      googleToken: async () => ({ accessToken: 'tok', email: 'support@widebed.com' }),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].headers.authorization).toBe('Bearer tok');
    const raw = Buffer.from(JSON.parse(sent[0].body).raw, 'base64url').toString();
    expect(raw).toContain('To: ana@example.com');
    expect(raw).toContain('Subject: Hi Ana');
    expect(r.status).toBe('failed'); // second item has a line break in "To"
    expect(r.error?.code).toBe('INVALID_HEADER');
  });
  it('extracts the plain-text body from multipart messages', () => {
    const payload = { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: Buffer.from('<b>x</b>').toString('base64url') } }, { mimeType: 'text/plain', body: { data: Buffer.from('plain text').toString('base64url') } }] };
    expect(extractBody(payload)).toBe('plain text');
  });
});

/* ------------------------------------------------------------- Google Sheets */

/** A tiny fake of the Google Sheets API: one spreadsheet with tabs of cells. */
function fakeSheets(tabs: Record<string, unknown[][]>, opts: { ids?: Record<string, number> } = {}) {
  const calls: { method: string; url: string; body: any }[] = [];
  const ids = opts.ids ?? Object.fromEntries(Object.keys(tabs).map((t, i) => [t, i * 100]));
  const json = (status: number, body: unknown) => ({ status, statusText: '', headers: {}, body: JSON.stringify(body), url: '' });
  const tabOf = (range: string) => {
    const m = /^'((?:[^']|'')*)'/.exec(range);
    return m ? m[1]!.replace(/''/g, "'") : range.split('!')[0]!;
  };
  const colNum = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const http = {
    async request(req: { method: string; url: string; body?: string; headers?: Record<string, string> }) {
      const u = new URL(req.url);
      const body = req.body ? JSON.parse(req.body) : null;
      calls.push({ method: req.method, url: req.url, body });
      expect(req.headers?.authorization).toBe('Bearer tok');
      const path = decodeURIComponent(u.pathname.replace('/v4/spreadsheets/', ''));
      const [id, rest = ''] = path.split(/\/(.*)/s);
      if (id !== 'SHEET123456789012345678') return json(404, { error: { message: 'Requested entity was not found.' } });
      if (!rest && req.method === 'GET') return json(200, { sheets: Object.keys(tabs).map((title) => ({ properties: { sheetId: ids[title], title } })) });
      if (rest === 'values:batchUpdate') {
        for (const d of body.data) {
          const [, cell] = d.range.split('!');
          const m = /^([A-Z]+)(\d+)$/.exec(cell)!;
          const grid = tabs[tabOf(d.range)]!;
          const r = Number(m[2]) - 1;
          while (grid.length <= r) grid.push([]);
          grid[r]![colNum(m[1]!)] = d.values[0][0];
        }
        return json(200, {});
      }
      const range = rest.replace(/^values\//, '').replace(/:append$/, '');
      const title = tabOf(range);
      const grid = tabs[title];
      if (!grid) return json(400, { error: { message: `Unable to parse range: ${range}` } });
      if (req.method === 'GET') return json(200, { range: `'${title}'!A1:Z${grid.length}`, values: grid });
      if (rest.endsWith(':append')) {
        const start = grid.length + 1;
        for (const row of body.values) grid.push(row.map((v: unknown) => v ?? ''));
        return json(200, { updates: { updatedRange: `'${title}'!A${start}:Z${grid.length}` } });
      }
      return json(500, { error: { message: 'unexpected call' } });
    },
  };
  return { http, calls, tabs };
}

describe('Google Sheets nodes', () => {
  const LINK = 'https://docs.google.com/spreadsheets/d/SHEET123456789012345678/edit#gid=100';
  const google = { googleToken: async () => ({ accessToken: 'tok', email: 'support@widebed.com', scopes: ['https://www.googleapis.com/auth/spreadsheets'] }) };
  const tenants = () => ({
    Owners: [['Name'], ['Bob']],
    Tenants: [
      ['Name', 'Email', 'Status', 'Room'],
      ['Ana Lee', 'ana@example.com', 'Unpaid', 'A-12'],
      [],
      ['Ben Tan', 'ben@example.com', 'Paid', 'B-03'],
      ['Cai Wu', 'cai@example.com', 'unpaid ', 'C-01'],
    ],
  });
  const flow = (type: string, config: Record<string, unknown>) => ({
    schemaVersion: 1 as const,
    nodes: [node('t', 'trigger.manual'), node('s', type, config, { credentialId: 'cred_g' })],
    connections: [edge('t', 's')],
  });

  it('parses links and helpers', () => {
    expect(parseSpreadsheet(LINK)).toEqual({ id: 'SHEET123456789012345678', gid: '100' });
    expect(parseSpreadsheet('SHEET123456789012345678')).toEqual({ id: 'SHEET123456789012345678', gid: null });
    expect(() => parseSpreadsheet('https://example.com')).toThrow(/not a Google Sheets link/);
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(cellValue('=IMPORTXML("x")', false)).toBe(`'=IMPORTXML("x")`);
    expect(cellValue('=SUM(A1:A2)', true)).toBe('=SUM(A1:A2)');
    expect(cellValue('-12.5', false)).toBe('-12.5');
    expect(cellValue({ a: 1 }, false)).toBe('{"a":1}');
  });

  it('reads rows of the tab in the link, skips empty rows and filters ignoring case', async () => {
    const fake = fakeSheets(tenants());
    const r = await run(flow('comm.sheetsRead', { spreadsheet: LINK, filters: [{ key: 'status', value: 'UNPAID' }] }), [{}], { http: fake.http as any, ...google });
    expect(r.status).toBe('success');
    expect(r.outputs.s!.main!.map((i) => i.json)).toEqual([
      { Name: 'Ana Lee', Email: 'ana@example.com', Status: 'Unpaid', Room: 'A-12', row_number: 2 },
      { Name: 'Cai Wu', Email: 'cai@example.com', Status: 'unpaid ', Room: 'C-01', row_number: 5 },
    ]);
    // Read once even with several input items.
    const fake2 = fakeSheets(tenants());
    const r2 = await run(flow('comm.sheetsRead', { spreadsheet: LINK, sheet: 'Tenants', returnMode: 'first' }), [{}, {}], { http: fake2.http as any, ...google });
    expect(r2.outputs.s!.main).toHaveLength(2);
    expect(fake2.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('explains a missing column or tab in plain words', async () => {
    const fake = fakeSheets(tenants());
    const r = await run(flow('comm.sheetsRead', { spreadsheet: LINK, sheet: 'Tenants', filters: [{ key: 'Phone', value: '1' }] }), [{}], { http: fake.http as any, ...google });
    expect(r.error?.message).toMatch(/Column “Phone” is not in the header row of “Tenants”. Columns are: Name, Email, Status, Room/);
    const r2 = await run(flow('comm.sheetsRead', { spreadsheet: LINK, sheet: 'Nope' }), [{}], { http: fake.http as any, ...google });
    expect(r2.error?.code).toBe('SHEET_TAB');
  });

  it('asks to reconnect when the Google connection has no Sheets permission', async () => {
    const r = await run(flow('comm.sheetsRead', { spreadsheet: LINK }), [{}], { http: fakeSheets(tenants()).http as any, googleToken: async () => ({ accessToken: 'tok', email: 'x', scopes: ['openid', 'https://www.googleapis.com/auth/gmail.send'] }) });
    expect(r.error?.code).toBe('SHEETS_SCOPE');
    expect(r.error?.message).toMatch(/Reconnect/);
  });

  it('adds rows by column name in one call, writing risky text as plain text', async () => {
    const fake = fakeSheets(tenants());
    const r = await run(
      flow('comm.sheetsCreateRow', { spreadsheet: LINK, sheet: 'Tenants', columns: [{ key: 'room', value: '{{ $json.room }}' }, { key: 'Name', value: '{{ $json.name }}' }] }),
      [{ name: 'Dan', room: 'D-1' }, { name: '=HYPERLINK("evil")', room: 'E-2' }],
      { http: fake.http as any, ...google },
    );
    expect(r.status).toBe('success');
    expect(fake.calls.filter((c) => c.url.includes(':append'))).toHaveLength(1);
    expect(fake.tabs.Tenants!.slice(-2)).toEqual([['Dan', '', '', 'D-1'], [`'=HYPERLINK("evil")`, '', '', 'E-2']]);
    expect(r.outputs.s!.main!.map((i) => i.json)).toEqual([
      { Room: 'D-1', Name: 'Dan', row_number: 6 },
      { Room: 'E-2', Name: '=HYPERLINK("evil")', row_number: 7 },
    ]);
  });

  it('adds rows from all matching item fields', async () => {
    const fake = fakeSheets(tenants());
    await run(flow('comm.sheetsCreateRow', { spreadsheet: LINK, sheet: 'Tenants', mode: 'all' }), [{ name: 'Eve', email: 'eve@x.com', other: 1 }], { http: fake.http as any, ...google });
    expect(fake.tabs.Tenants!.at(-1)).toEqual(['Eve', 'eve@x.com', '', '']);
  });

  it('updates only the listed cells of the matching row', async () => {
    const fake = fakeSheets(tenants());
    const r = await run(
      flow('comm.sheetsUpdateRow', { spreadsheet: LINK, sheet: 'Tenants', matchColumn: 'Email', matchValue: '{{ $json.email }}', columns: [{ key: 'Status', value: 'Paid' }] }),
      [{ email: 'ANA@example.com ' }, { email: 'nobody@example.com' }],
      { http: fake.http as any, ...google },
    );
    expect(r.status).toBe('success');
    expect(fake.tabs.Tenants![1]).toEqual(['Ana Lee', 'ana@example.com', 'Paid', 'A-12']);
    const batch = fake.calls.find((c) => c.url.endsWith('values:batchUpdate'))!;
    expect(batch.body.data).toEqual([{ range: "'Tenants'!C2", values: [['Paid']] }]);
    // The not-found item is skipped (not passed on).
    expect(r.outputs.s!.main!.map((i) => i.json)).toEqual([
      { Name: 'Ana Lee', Email: 'ana@example.com', Status: 'Paid', Room: 'A-12', row_number: 2, action: 'updated' },
    ]);
  });

  it('can add a missing row, update all matches, or stop with an error', async () => {
    const fake = fakeSheets(tenants());
    const r = await run(
      flow('comm.sheetsUpdateRow', { spreadsheet: LINK, sheet: 'Tenants', matchColumn: 'Email', matchValue: '{{ $json.email }}', columns: [{ key: 'Status', value: 'New' }], ifNotFound: 'add' }),
      [{ email: 'zed@example.com' }, { email: 'zed@example.com' }],
      { http: fake.http as any, ...google },
    );
    expect(r.status).toBe('success');
    // Added once; the second item found the new row instead of adding it again.
    expect(fake.tabs.Tenants!.filter((row) => row[1] === 'zed@example.com')).toEqual([['', 'zed@example.com', 'New', '']]);

    const fake2 = fakeSheets(tenants());
    await run(flow('comm.sheetsUpdateRow', { spreadsheet: LINK, sheet: 'Tenants', matchColumn: 'Status', matchValue: 'unpaid', columns: [{ key: 'Room', value: 'X' }], multiple: 'all' }), [{}], { http: fake2.http as any, ...google });
    expect(fake2.tabs.Tenants!.filter((row) => row[3] === 'X')).toHaveLength(2);

    const r3 = await run(flow('comm.sheetsUpdateRow', { spreadsheet: LINK, sheet: 'Tenants', matchColumn: 'Email', matchValue: 'none', columns: [{ key: 'Room', value: 'X' }], ifNotFound: 'error' }), [{}], { http: fakeSheets(tenants()).http as any, ...google });
    expect(r3.error?.code).toBe('SHEET_ROW_NOT_FOUND');
  });

  it('validates required settings', () => {
    const v = (type: string, cfg: Record<string, unknown>) => registry.validateNodeConfig(node('s', type, cfg)).map((i) => i.message).join();
    expect(v('comm.sheetsRead', {})).toMatch(/link/);
    expect(v('comm.sheetsUpdateRow', { spreadsheet: LINK, matchValue: 'x' })).toMatch(/column/);
    expect(v('comm.sheetsUpdateRow', { spreadsheet: LINK, matchColumn: 'ID', matchValue: '{{ $json.id }}', columns: [{ key: 'A', value: 1 }] })).toBe('');
  });
});

/* ------------------------------------------------------------------------ AI */

describe('AI nodes', () => {
  const flow = (type: string, config: Record<string, unknown>, extra: WorkflowNode[] = [], edges: ReturnType<typeof edge>[] = []) => ({
    schemaVersion: 1 as const,
    nodes: [node('t', 'trigger.manual'), node('a', type, config, { credentialId: 'cred_ai' }), ...extra],
    connections: [edge('t', 'a'), ...edges],
  });
  const fakeAi = (answer: (prompt: string) => string) => {
    const calls: any[] = [];
    return { calls, ai: async (id: string, req: any) => { calls.push({ id, ...req }); return { text: answer(req.prompt), model: 'test-model' }; } };
  };

  it('AI Write adds the answer to each item and keeps the item’s fields', async () => {
    const f = fakeAi((p) => `Reply to: ${p.split('\n').pop()}`);
    const r = await run(flow('ai.chat', { prompt: 'Write a reply to\n{{ $json.body }}', rules: 'Be brief', length: 'short' }), [{ from: 'a@x.com', body: 'Is parking free?' }], { ai: f.ai as any });
    expect(r.status).toBe('success');
    expect(r.outputs.a!.main!.map((i) => i.json)).toEqual([{ from: 'a@x.com', body: 'Is parking free?', answer: 'Reply to: Is parking free?' }]);
    expect(f.calls[0]).toMatchObject({ id: 'cred_ai', system: 'Be brief', maxTokens: 3000 });
  });

  it('AI Sort sends items to the chosen category or to Other', async () => {
    const f = fakeAi((p) => (p.includes('aircon') ? '```json\n{"category": "complaint", "reason": "Broken aircon"}\n```' : '{"category": "Something else", "reason": "?"}'));
    const cats = [{ id: 'c_b', label: 'Booking question', value: 'availability' }, { id: 'c_c', label: 'Complaint', value: 'broken things' }];
    const r = await run(flow('ai.classify', { text: '{{ $json.body }}', categories: cats }), [{ body: 'The aircon is broken' }, { body: 'Hello' }], { ai: f.ai as any });
    expect(r.status).toBe('success');
    expect(r.outputs.a!.c_c!.map((i) => i.json)).toEqual([{ body: 'The aircon is broken', category: 'Complaint', reason: 'Broken aircon' }]);
    expect(r.outputs.a!.otherwise!.map((i) => i.json.category)).toEqual(['Other']);
    expect(f.calls[0].json).toBe(true);
    expect(f.calls[0].prompt).toContain('- Complaint: broken things');
  });

  it('AI Pull Out Details fills the listed fields (empty when missing)', async () => {
    const f = fakeAi(() => '{"guestName": "Ana Lee", "checkIn": "2026-12-01", "extra": "ignored"}');
    const r = await run(flow('ai.extract', { text: '{{ $json.body }}', fields: [{ key: 'guestName', value: 'Guest name' }, { key: 'checkIn', value: 'date' }, { key: 'nights', value: 'number' }] }), [{ body: 'Booking for Ana' }], { ai: f.ai as any });
    expect(r.outputs.a!.main![0]!.json).toEqual({ body: 'Booking for Ana', guestName: 'Ana Lee', checkIn: '2026-12-01', nights: '' });
  });

  it('explains missing connections and bad answers in plain words, and cuts very long texts', async () => {
    const noCred = { schemaVersion: 1 as const, nodes: [node('t', 'trigger.manual'), node('a', 'ai.chat', { prompt: 'x' })], connections: [edge('t', 'a')] };
    expect(validateWorkflow(noCred, registry).map((i) => i.message).join()).toMatch(/choose a connection/);
    const bad = await run(flow('ai.extract', { text: 'x', fields: [{ key: 'a', value: 'a' }] }), [{}], { ai: fakeAi(() => 'Sorry, I cannot').ai as any });
    expect(bad.error?.code).toBe('AI_FORMAT');
    const f = fakeAi(() => 'ok');
    await run(flow('ai.chat', { prompt: '{{ $json.big }}' }), [{ big: 'x'.repeat(40_000) }], { ai: f.ai as any });
    expect(f.calls[0].prompt.length).toBeLessThan(31_000);
    expect(f.calls[0].prompt).toMatch(/cut/);
  });

  it('validates the settings', () => {
    const v = (type: string, cfg: Record<string, unknown>) => registry.validateNodeConfig(node('a', type, cfg)).map((i) => i.message).join();
    expect(v('ai.chat', { prompt: '' })).toMatch(/Describe what the AI should do/);
    expect(v('ai.chat', { prompt: 'x', saveAs: 'my answer' })).toMatch(/letters, numbers/);
    expect(v('ai.classify', { text: 'x', categories: [{ id: 'a', label: 'One', value: '' }] })).toMatch(/two categories/);
    expect(v('ai.extract', { text: 'x', fields: [{ key: 'guest name', value: '' }] })).toMatch(/Field names/);
    expect(v('ai.extract', { text: 'x', fields: [{ key: 'guestName', value: 'Name' }] })).toBe('');
    expect(parseAiJson('Here you go: {"a": 1}')).toEqual({ a: 1 });
  });
});

/* ------------------------------------------------------------- Dates + Combine */

describe('Date checks', () => {
  // Sat 14 Nov 2026, 23:30 in Kuala Lumpur (15:30 UTC) — late evening, to catch time-zone mistakes.
  const now = new Date('2026-11-14T15:30:00Z');
  const is = (left: unknown, op: string, right: unknown = '') => evaluateCondition(left, op as any, right, { now });

  it('reads the date formats found in Widebed data', () => {
    expect(parseDay('2026-12-01')).toBe('2026-12-01');
    expect(parseDay('01/12/2026')).toBe('2026-12-01');
    expect(parseDay('1 Dec 2026')).toBe('2026-12-01');
    expect(parseDay('Dec 1, 2026')).toBe('2026-12-01');
    expect(parseDay('2026-11-14T17:00:00.000Z')).toBe('2026-11-15'); // 1 AM next day in KL
    expect(parseDay({ seconds: Date.parse('2026-11-14T17:00:00Z') / 1000 })).toBe('2026-11-15');
    expect(parseDay('2026-02-30')).toBeNull();
    expect(parseDay('soon')).toBeNull();
  });

  it('answers today / tomorrow / N days questions in Malaysia time', () => {
    expect(is('2026-11-14', 'isToday')).toBe(true);
    expect(is('2026-11-15', 'isTomorrow')).toBe(true);
    expect(is('13/11/2026', 'isYesterday')).toBe(true);
    expect(is('2026-11-10', 'isInPast')).toBe(true);
    expect(is('2026-11-14', 'isInPast')).toBe(false);
    expect(is('2026-11-20', 'withinNextDays', 7)).toBe(true);
    expect(is('2026-11-22', 'withinNextDays', '7')).toBe(false);
    expect(is('2026-11-10T03:00:00Z', 'moreThanDaysAgo', 3)).toBe(true);
    expect(is('2026-11-11', 'moreThanDaysAgo', 3)).toBe(false);
    expect(is('2026-11-08', 'withinLastDays', 7)).toBe(true);
    expect(is('2027-01-13', 'isDaysFromToday', 60)).toBe(true);
    expect(is('', 'isToday')).toBe(false);
    expect(is('not a date', 'isInPast')).toBe(false);
  });

  it('gives {{ $today }} values', () => {
    expect(todayInfo(now)).toMatchObject({ date: '2026-11-14', tomorrow: '2026-11-15', yesterday: '2026-11-13', display: '14 Nov 2026', weekday: 'Saturday', month: '2026-11', monthName: 'November 2026' });
  });

  it('filters by date inside a workflow and combines the rest into one item', async () => {
    const today = todayInfo().date;
    const def: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        node('t', 'trigger.manual'),
        node('f', 'logic.filter', { conditions: [{ left: '{{ $json.arrival }}', operator: 'withinNextDays', right: 1 }] }),
        node('c', 'logic.combine', { line: '• {{ $json.unit }} on {{ $json.arrival }}', sortBy: 'arrival', saveAs: 'list' }),
        node('d', 'logic.filter', { conditions: [{ left: 'Today is {{ $today.display }}', operator: 'isNotEmpty', right: '' }] }),
      ],
      connections: [edge('t', 'f'), edge('f', 'c'), edge('c', 'd')],
    };
    const tomorrow = todayInfo(new Date(Date.now() + 86_400_000)).date;
    const r = await run(def, [{ unit: 'B-2', arrival: tomorrow }, { unit: 'A-1', arrival: today }, { unit: 'Z-9', arrival: '2020-01-01' }]);
    expect(r.status).toBe('success');
    expect(r.outputs.c!.main).toHaveLength(1);
    expect(r.outputs.c!.main![0]!.json).toMatchObject({ count: 2, list: `• A-1 on ${today}\n• B-2 on ${tomorrow}` });

    // Nothing to report → the next steps are skipped.
    const none = await run(def, [{ unit: 'Z-9', arrival: '2020-01-01' }]);
    expect(none.steps.find((s) => s.nodeId === 'c')!.status).toBe('skipped');
  });

  it('resolves {{ $today }} in expressions', () => {
    const scope = { nodes: {}, executionId: 'e', workflowId: 'w', now: () => '2026-11-14T15:30:00.000Z' };
    expect(resolveValue('{{ $today }}', scope)).toBe('2026-11-14');
    expect(resolveValue('Arrivals on {{ $today.tomorrow }} ({{ $today.weekday }})', scope)).toBe('Arrivals on 2026-11-15 (Saturday)');
  });
});
