import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';
import { convertN8n, convertValue } from '../src/services/workflow-transfer.js';
import { validateWorkflow } from '@widebed/engine';

const people: Record<string, { role: string; department: string | null }> = {
  boss: { role: 'super_admin', department: null },
  ops: { role: 'department_manager', department: 'Ops' },
};
const verifier: TokenVerifier = { verify: async (t) => ({ uid: t.replace('tok-', ''), email: `${t}@x.com`, name: t, emailVerified: true }) };
const as = (uid: string) => ({ Authorization: `Bearer tok-${uid}` });
const repos = createMemoryRepositories();
const ctx = buildContext(
  loadConfig({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: 't', ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), RATE_LIMIT_PER_MINUTE: '10000' } as any),
  repos,
  verifier,
);
startProcessing(ctx);
const app = createApp(ctx);

beforeAll(async () => {
  for (const [uid, p] of Object.entries(people)) {
    await repos.users.create({ uid, name: uid, email: `${uid}@x.com`, role: p.role as any, department: p.department, status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null });
  }
});

/** A small, made-up n8n workflow with the same shapes as real exports. */
const n8nFile = {
  name: 'Guest reminders',
  active: true,
  settings: { timezone: 'Asia/Kuala_Lumpur' },
  nodes: [
    { id: 'a1', name: 'Every morning', type: 'n8n-nodes-base.scheduleTrigger', position: [0, 0], parameters: { rule: { interval: [{ triggerAtHour: 9 }] } } },
    { id: 'a2', name: 'Read sheet', type: 'n8n-nodes-base.googleSheets', position: [200, 0], parameters: { documentId: { value: 'x' } }, credentials: { googleSheetsOAuth2Api: { id: '1', name: 'Sheets' } } },
    { id: 'a3', name: 'Flags', type: 'n8n-nodes-base.code', position: [400, 0], parameters: { jsCode: 'return items.map((item) => ({ json: { ...item.json, soon: item.json.days === 1 } }));' } },
    { id: 'a4', name: 'Soon?', type: 'n8n-nodes-base.if', position: [600, 0], parameters: { conditions: { combinator: 'and', conditions: [{ leftValue: '={{ $json.soon }}', rightValue: '={{ true }}', operator: { type: 'boolean', operation: 'equals' } }] } } },
    { id: 'a5', name: 'Email guest', type: 'n8n-nodes-base.gmail', position: [800, 0], parameters: { sendTo: '={{ $json.Email }}', subject: "=Your stay at {{ $json['Property Name'] }}", message: '=<p>Hi {{ $json.Name }}</p><p>{{ $json.date.toDateTime().toFormat("dd MMM") }}</p>', options: { ccList: 'ops@example.com', senderName: 'Widebed' } }, credentials: { gmailOAuth2: { id: '9', name: 'Gmail' } } },
    { id: 'a6', name: 'Join owners', type: 'n8n-nodes-base.merge', position: [300, 200], parameters: { mode: 'combine', advanced: true, mergeByFields: { values: [{ field1: 'Unit', field2: 'Unit' }] }, joinMode: 'enrichInput1' } },
    { id: 'a8', name: 'Make card', type: 'n8n-nodes-base.trello', position: [1000, 0], parameters: { operation: 'create' } },
    { id: 'a7', name: 'Note', type: 'n8n-nodes-base.stickyNote', position: [0, 400], parameters: { content: 'hi' } },
  ],
  connections: {
    'Every morning': { main: [[{ node: 'Read sheet', type: 'main', index: 0 }]] },
    'Read sheet': { main: [[{ node: 'Join owners', type: 'main', index: 0 }]] },
    'Join owners': { main: [[{ node: 'Flags', type: 'main', index: 0 }]] },
    Flags: { main: [[{ node: 'Soon?', type: 'main', index: 0 }]] },
    'Soon?': { main: [[{ node: 'Email guest', type: 'main', index: 0 }], []] },
    'Email guest': { main: [[{ node: 'Make card', type: 'main', index: 0 }]] },
  },
};

describe('n8n Google Sheets conversion', () => {
  const one = (parameters: Record<string, unknown>) => {
    const res = convertN8n({ name: 'x', nodes: [{ id: 'g', name: 'Sheet', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5, position: [0, 0], parameters }], connections: {} });
    return res.definition.nodes[0]!;
  };
  const doc = { __rl: true, mode: 'list', value: '1AbCdEfGhIjKlMnOpQrStUvWxYz', cachedResultUrl: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit' };
  const tab = { __rl: true, mode: 'list', value: 1234, cachedResultName: 'Tenants' };

  it('maps “Get Row(s)” with a filter to Read Rows', () => {
    const n = one({ documentId: doc, sheetName: tab, filtersUI: { values: [{ lookupColumn: 'Status', lookupValue: '=Unpaid' }] }, options: { returnAllMatches: 'returnFirstMatch' } });
    expect(n.type).toBe('comm.sheetsRead');
    expect(n.config).toMatchObject({ spreadsheet: doc.cachedResultUrl, sheet: 'Tenants', headerRow: 1, filters: [{ key: 'Status', value: 'Unpaid' }], returnMode: 'first' });
  });
  it('maps Append with mapped columns to Add Row, and the sheet id to gid=', () => {
    const n = one({ operation: 'append', documentId: doc, sheetName: { __rl: true, mode: 'id', value: '0' }, columns: { mappingMode: 'defineBelow', value: { Name: '={{ $json.name }}', Room: 'A-12' } } });
    expect(n.type).toBe('comm.sheetsCreateRow');
    expect(n.config).toMatchObject({ sheet: 'gid=0', mode: 'fields', columns: [{ key: 'Name', value: '{{ $json.name }}' }, { key: 'Room', value: 'A-12' }] });
  });
  it('maps Update / Append-or-Update to Update Row with the matching column', () => {
    const n = one({ operation: 'appendOrUpdate', documentId: doc, sheetName: tab, columns: { mappingMode: 'defineBelow', matchingColumns: ['Email'], value: { Email: '={{ $json.email }}', 'Password Expiry': '={{ $json.expiry }}' } } });
    expect(n.type).toBe('comm.sheetsUpdateRow');
    expect(n.config).toMatchObject({ matchColumn: 'Email', matchValue: '{{ $json.email }}', columns: [{ key: 'Password Expiry', value: '{{ $json.expiry }}' }], ifNotFound: 'add', multiple: 'first' });
    expect(one({ operation: 'update', documentId: doc, sheetName: tab, columns: { mappingMode: 'autoMapInputData', matchingColumns: ['ID'] } }).config).toMatchObject({ matchColumn: 'ID', matchValue: '{{ $json["ID"] }}', mode: 'all', ifNotFound: 'skip' });
  });
  it('keeps unsupported Sheets operations as placeholders', () => {
    expect(one({ operation: 'delete', documentId: doc, sheetName: tab }).type).toBe('util.unsupported');
  });
});

describe('n8n import', () => {
  it('converts supported nodes, keeps unsupported ones as placeholders, and reports everything', async () => {
    const res = await request(app).post('/api/workflows/import').set(as('boss')).send({ file: n8nFile });
    expect(res.status).toBe(201);
    const { report } = res.body;
    expect(report.source).toBe('n8n');
    expect(report.converted.map((c: any) => c.to).sort()).toEqual(['comm.gmailSend', 'comm.sheetsRead', 'data.code', 'logic.if', 'logic.merge', 'trigger.schedule']);
    expect(report.unsupported).toEqual([{ name: 'Make card', type: 'n8n-nodes-base.trello', reason: 'No equivalent node yet' }]);
    expect(report.needsCredential).toEqual(['Read sheet', 'Email guest']);
    expect(report.warnings.join('\n')).toMatch(/toDateTime/);
    expect(report.warnings.join('\n')).toMatch(/Sender name/);

    const wf = await request(app).get(`/api/workflows/${res.body.workflow.workflowId}`).set(as('boss'));
    expect(wf.body.status).toBe('inactive');
    const nodes = Object.fromEntries(wf.body.draftDefinition.nodes.map((n: any) => [n.name, n]));
    expect(nodes['Every morning'].config).toEqual({ mode: 'daily', time: '09:00', timezone: 'Asia/Kuala_Lumpur' });
    expect(nodes['Soon?'].config.conditions[0]).toEqual({ left: '{{ $json.soon }}', operator: 'isTrue', right: '' });
    expect(nodes['Email guest'].config.subject).toBe("Your stay at {{ $json['Property Name'] }}");
    expect(nodes['Join owners'].config).toMatchObject({ mode: 'matchFields', join: 'left' });
    expect(nodes['Read sheet'].type).toBe('comm.sheetsRead');
    expect(nodes['Make card'].type).toBe('util.unsupported');
    expect(nodes.Note).toBeUndefined(); // sticky notes are dropped
    const conn = wf.body.draftDefinition.connections.find((c: any) => c.source === nodes['Soon?'].id);
    expect(conn.sourceHandle).toBe('true');

    // Publishing is blocked while a placeholder remains.
    const pub = await request(app).post(`/api/workflows/${res.body.workflow.workflowId}/publish`).set(as('boss'));
    expect(pub.status).toBe(422);
    expect(JSON.stringify(pub.body.details)).toMatch(/not supported yet/);
  });

  it('runs converted n8n code in the sandbox', async () => {
    const file = {
      name: 'code only',
      nodes: [
        { id: 'm', name: 'Start', type: 'n8n-nodes-base.manualTrigger', position: [0, 0], parameters: {} },
        { id: 'c', name: 'Flags', type: 'n8n-nodes-base.code', position: [200, 0], parameters: { jsCode: n8nFile.nodes[2].parameters.jsCode } },
      ],
      connections: { Start: { main: [[{ node: 'Flags', type: 'main', index: 0 }]] } },
    };
    const imp = await request(app).post('/api/workflows/import').set(as('boss')).send({ file });
    const id = imp.body.workflow.workflowId;
    const wf = await request(app).get(`/api/workflows/${id}`).set(as('boss'));
    wf.body.draftDefinition.nodes[0].config.testData = '[{"days":1},{"days":5}]';
    await request(app).put(`/api/workflows/${id}/draft`).set(as('boss')).send({ definition: wf.body.draftDefinition });
    const run = await request(app).post(`/api/workflows/${id}/run`).set(as('boss')).send({ mode: 'draft' });
    let exec: any;
    for (let i = 0; i < 100; i++) {
      exec = (await request(app).get(`/api/executions/${run.body.executionId}`).set(as('boss'))).body;
      if (['success', 'failed'].includes(exec.status)) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(exec.status).toBe('success');
    expect(exec.steps[1].outputData.main).toEqual([{ days: 1, soon: true }, { days: 5, soon: false }]);
  });

  it('refuses files with Code nodes for users who may not write code', async () => {
    const res = await request(app).post('/api/workflows/import').set(as('ops')).send({ file: n8nFile });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Code nodes/);
  });

  it('rejects files that are not workflows', async () => {
    expect((await request(app).post('/api/workflows/import').set(as('boss')).send({ file: { hello: 1 } })).status).toBe(400);
  });

  it('translates expressions', () => {
    const w: string[] = [];
    expect(convertValue('={{ $json.a }}', (m) => w.push(m), 'x')).toBe('{{ $json.a }}');
    expect(convertValue('={{ false }}', (m) => w.push(m), 'x')).toBe(false);
    expect(convertValue('={{ "" }}', (m) => w.push(m), 'x')).toBe('');
    expect(convertValue("=ID {{ $('Code').item.json.ID }}", (m) => w.push(m), 'x')).toBe('ID {{ $node["Code"].json.ID }}');
    expect(convertValue('plain text', (m) => w.push(m), 'x')).toBe('plain text');
    expect(w.join()).toMatch(/FIRST item/);
  });
});

describe('Widebed export / import', () => {
  it('round-trips a workflow and re-links connections by name', async () => {
    const { credential } = await ctx.credentials.createEventSource({ uid: 'boss', role: 'super_admin' } as any, 'PMS events');
    const created = await request(app).post('/api/workflows').set(as('boss')).send({ name: 'Round trip', tags: ['x'] });
    const id = created.body.workflowId;
    const definition = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', name: 'Start', position: { x: 0, y: 0 }, config: {} },
        { id: 'w', type: 'logic.wait', name: 'Pause', position: { x: 200, y: 0 }, config: { amount: 1, unit: 'seconds' } },
      ],
      connections: [{ id: 'c', source: 't', sourceHandle: 'main', target: 'w', targetHandle: 'main' }],
    };
    await request(app).put(`/api/workflows/${id}/draft`).set(as('boss')).send({ definition });
    const exp = await request(app).get(`/api/workflows/${id}/export`).set(as('boss'));
    expect(exp.headers['content-disposition']).toMatch(/round-trip\.widebed\.json/);
    expect(exp.body.format).toBe('widebed-automation/workflow');
    expect(JSON.stringify(exp.body)).not.toMatch(/encrypted|private_key/);
    expect(credential.provider).toBe('event_source');

    const imp = await request(app).post('/api/workflows/import').set(as('boss')).send({ file: exp.body });
    expect(imp.status).toBe(201);
    expect(imp.body.report.source).toBe('widebed');
    const copy = await request(app).get(`/api/workflows/${imp.body.workflow.workflowId}`).set(as('boss'));
    expect(copy.body.draftDefinition.nodes).toEqual(definition.nodes);
    expect(copy.body.tags).toEqual(['x']);
    expect(copy.body.workflowId).not.toBe(id);
  });
});

describe('Templates', () => {
  const fileFor = (t: any, name: string) => ({ format: 'widebed-automation/workflow', formatVersion: 1, exportedAt: new Date().toISOString(), workflow: { name, description: t.description, tags: ['template'], definition: t.definition }, credentials: [] });

  it('lists the built-in templates, all valid apart from the links and connections to fill in', async () => {
    const res = await request(app).get('/api/templates').set(as('ops'));
    expect(res.status).toBe(200);
    expect(res.body.builtIn.length).toBeGreaterThanOrEqual(9);
    for (const t of res.body.builtIn) {
      const issues = validateWorkflow(t.definition, ctx.registry).filter((i) => !/choose a connection|Paste the link/.test(i.message));
      expect({ id: t.templateId, issues }).toEqual({ id: t.templateId, issues: [] });
      expect(JSON.stringify(t.definition)).not.toMatch(/cred_/);
    }
  });

  it('creates a workflow from a template and picks the only Google connection automatically', async () => {
    await repos.credentials.create({ credentialId: 'cred_google1', name: 'Support inbox', provider: 'google_oauth', department: null, ownerId: 'boss', status: 'connected', details: { accountEmail: 'support@widebed.com' }, encryptedSecretReference: 'x', lastTestedAt: null, lastTestResult: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
    const list = await request(app).get('/api/templates').set(as('ops'));
    const rent = list.body.builtIn.find((t: any) => t.templateId === 'tpl_rent_reminder');
    const imp = await request(app).post('/api/workflows/import').set(as('ops')).send({ file: fileFor(rent, 'x'), name: 'Rent reminder – Block A', autoConnect: true });
    expect(imp.status).toBe(201);
    expect(imp.body.report.needsCredential).toEqual([]);
    const wf = await request(app).get(`/api/workflows/${imp.body.workflow.workflowId}`).set(as('ops'));
    expect(wf.body.name).toBe('Rent reminder – Block A');
    expect(wf.body.department).toBe('Ops');
    expect(wf.body.draftDefinition.nodes.filter((n: any) => n.credentialId === 'cred_google1')).toHaveLength(2);

    // With two possible accounts, nothing is guessed.
    await repos.credentials.create({ credentialId: 'cred_google2', name: 'Sales inbox', provider: 'google_oauth', department: null, ownerId: 'boss', status: 'connected', details: {}, encryptedSecretReference: 'x', lastTestedAt: null, lastTestResult: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
    const imp2 = await request(app).post('/api/workflows/import').set(as('ops')).send({ file: fileFor(rent, 'x'), autoConnect: true });
    expect(imp2.body.report.needsCredential).toEqual(['Unpaid tenants', 'Email the tenant']);
  });

  it('saves a workflow as a template without its connections, and only the creator or an admin can delete it', async () => {
    const created = await request(app).post('/api/workflows').set(as('ops')).send({ name: 'Ops flow' });
    const id = created.body.workflowId;
    const definition = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', name: 'Start', position: { x: 0, y: 0 }, config: {} },
        { id: 'g', type: 'comm.gmailSend', name: 'Mail', position: { x: 200, y: 0 }, config: { to: 'a@b.c', subject: 's', body: 'b' }, credentialId: 'cred_google1' },
      ],
      connections: [{ id: 'c', source: 't', sourceHandle: 'main', target: 'g', targetHandle: 'main' }],
    };
    await request(app).put(`/api/workflows/${id}/draft`).set(as('ops')).send({ definition });
    const saved = await request(app).post('/api/templates').set(as('ops')).send({ workflowId: id, name: 'Ops mail', category: 'Team' });
    expect(saved.status).toBe(201);
    expect(saved.body.definition.nodes[1].credentialId).toBeNull();
    expect(saved.body.createdByName).toBe('ops');
    const list = await request(app).get('/api/templates').set(as('boss'));
    expect(list.body.saved.map((t: any) => t.name)).toContain('Ops mail');

    const other = await request(app).post('/api/workflows').set(as('boss')).send({ name: 'Boss flow' });
    const bossTpl = await request(app).post('/api/templates').set(as('boss')).send({ workflowId: other.body.workflowId, name: 'Boss tpl' });
    expect((await request(app).delete(`/api/templates/${bossTpl.body.templateId}`).set(as('ops'))).status).toBe(403);
    expect((await request(app).delete(`/api/templates/${saved.body.templateId}`).set(as('ops'))).status).toBe(204);
    expect((await request(app).post('/api/templates').set(as('ops')).send({ workflowId: 'nope', name: 'x' })).status).toBe(404);
  });
});
