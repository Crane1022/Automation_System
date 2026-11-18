import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@widebed/shared';
import { createDefaultRegistry, createSafeHttpClient, isBlockedAddress } from '@widebed/nodes';
import { parsePath, resolveValue, runWorkflow, validateWorkflow } from '../src/index.js';

const registry = createDefaultRegistry();

let server: http.Server;
let base = '';
let flakyHits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/booking/')) {
      const id = req.url.split('/')[2];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, status: id === 'B1' ? 'confirmed' : 'cancelled', nights: id === 'B1' ? 3 : 0 }));
    } else if (req.url === '/flaky') {
      flakyHits++;
      if (flakyHits < 3) {
        res.writeHead(503);
        res.end('busy');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }
    } else if (req.url === '/notfound') {
      res.writeHead(404);
      res.end('nope');
    } else if (req.url === '/echo') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, body: JSON.parse(body || '{}') }));
      });
    } else if (req.url === '/slow') {
      setTimeout(() => res.end('late'), 2000);
    } else {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

// Tests talk to a local server, so private networks are allowed here.
const devHttp = createSafeHttpClient({
  allowPrivateNetworks: true,
  allowedPrivateHosts: [],
  maxResponseBytes: 1024 * 1024,
  maxRedirects: 3,
  defaultTimeoutMs: 5000,
});
const prodHttp = createSafeHttpClient({
  allowPrivateNetworks: false,
  allowedPrivateHosts: [],
  maxResponseBytes: 1024 * 1024,
  maxRedirects: 3,
  defaultTimeoutMs: 5000,
});

function bookingWorkflow(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 't', type: 'trigger.manual', name: 'Start', position: { x: 0, y: 0 }, config: {} },
      { id: 'h', type: 'data.httpRequest', name: 'Get Booking', position: { x: 1, y: 0 }, config: { method: 'GET', url: `${base}/booking/{{ $json.bookingId }}` } },
      { id: 'if', type: 'logic.if', name: 'Confirmed?', position: { x: 2, y: 0 }, config: { conditions: [{ left: '{{ $json.body.status }}', operator: 'equals', right: 'confirmed' }], combine: 'and' } },
      { id: 'yes', type: 'data.httpRequest', name: 'Notify', position: { x: 3, y: 0 }, config: { method: 'POST', url: `${base}/echo`, bodyType: 'json', body: '{"booking":"{{ $node["Get Booking"].json.body.id }}","nights":"{{ $json.body.nights }}"}' } },
      { id: 'no', type: 'data.httpRequest', name: 'Log Cancel', position: { x: 3, y: 1 }, config: { method: 'POST', url: `${base}/echo`, bodyType: 'json', body: '{}' } },
    ],
    connections: [
      { id: 'c1', source: 't', sourceHandle: 'main', target: 'h', targetHandle: 'main' },
      { id: 'c2', source: 'h', sourceHandle: 'main', target: 'if', targetHandle: 'main' },
      { id: 'c3', source: 'if', sourceHandle: 'true', target: 'yes', targetHandle: 'main' },
      { id: 'c4', source: 'if', sourceHandle: 'false', target: 'no', targetHandle: 'main' },
    ],
  };
}

describe('expressions', () => {
  it('parses paths', () => {
    expect(parsePath('$json.a["b c"][0].d')).toEqual(['$json', 'a', 'b c', 0, 'd']);
    expect(() => parsePath('$json.a + 1')).toThrow();
    expect(() => parsePath('process.exit()')).toThrow();
  });
  it('keeps raw types for single expressions and interpolates otherwise', () => {
    const scope = { item: { json: { n: 3, o: { x: 1 } } }, nodes: {}, executionId: 'e', workflowId: 'w' };
    expect(resolveValue('{{ $json.n }}', scope)).toBe(3);
    expect(resolveValue('n={{ $json.n }} o={{$json.o}}', scope)).toBe('n=3 o={"x":1}');
    expect(resolveValue('{{ $json.__proto__ }}', scope)).toBeUndefined();
  });
});

describe('graph validation', () => {
  it('reports missing trigger, cycles and bad config', () => {
    const def: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: 'a', type: 'logic.if', name: 'A', position: { x: 0, y: 0 }, config: { conditions: [] } },
        { id: 'b', type: 'logic.if', name: 'B', position: { x: 0, y: 0 }, config: { conditions: [{ left: 1, operator: 'equals', right: 1 }] } },
      ],
      connections: [
        { id: '1', source: 'a', sourceHandle: 'true', target: 'b', targetHandle: 'main' },
        { id: '2', source: 'b', sourceHandle: 'true', target: 'a', targetHandle: 'main' },
      ],
    };
    const msgs = validateWorkflow(def, registry).map((i) => i.message).join('\n');
    expect(msgs).toMatch(/trigger/);
    expect(msgs).toMatch(/loop/);
    expect(msgs).toMatch(/at least one condition/);
  });
  it('accepts a valid workflow', () => {
    expect(validateWorkflow(bookingWorkflow(), registry).filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('runWorkflow', () => {
  it('passes data between nodes and follows the true branch', async () => {
    const res = await runWorkflow({
      executionId: 'e1', workflowId: 'w1', definition: bookingWorkflow(), registry,
      services: { http: devHttp }, triggerItems: [{ json: { bookingId: 'B1' } }],
    });
    expect(res.status).toBe('success');
    const statuses = Object.fromEntries(res.steps.map((s) => [s.nodeId, s.status]));
    expect(statuses).toEqual({ t: 'success', h: 'success', if: 'success', yes: 'success', no: 'skipped' });
    expect(res.outputs.yes.main[0].json.body).toEqual({ method: 'POST', body: { booking: 'B1', nights: '3' } });
  });

  it('follows the false branch', async () => {
    const res = await runWorkflow({
      executionId: 'e2', workflowId: 'w1', definition: bookingWorkflow(), registry,
      services: { http: devHttp }, triggerItems: [{ json: { bookingId: 'B2' } }],
    });
    const statuses = Object.fromEntries(res.steps.map((s) => [s.nodeId, s.status]));
    expect(statuses.yes).toBe('skipped');
    expect(statuses.no).toBe('success');
  });

  it('retries retryable failures with backoff', async () => {
    flakyHits = 0;
    const def: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', name: 'Start', position: { x: 0, y: 0 }, config: {} },
        { id: 'h', type: 'data.httpRequest', name: 'Flaky', position: { x: 0, y: 0 }, config: { url: `${base}/flaky` }, retry: { maxAttempts: 3, backoffMs: 10 } },
      ],
      connections: [{ id: 'c', source: 't', sourceHandle: 'main', target: 'h', targetHandle: 'main' }],
    };
    const waits: number[] = [];
    const res = await runWorkflow({
      executionId: 'e3', workflowId: 'w', definition: def, registry, services: { http: devHttp },
      sleep: async (ms) => void waits.push(ms),
    });
    expect(res.status).toBe('success');
    expect(res.steps[1].attempt).toBe(3);
    expect(waits).toEqual([10, 20]);
  });

  it('does not retry non-retryable 4xx errors and records the error', async () => {
    const def: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', name: 'Start', position: { x: 0, y: 0 }, config: {} },
        { id: 'h', type: 'data.httpRequest', name: 'Missing', position: { x: 0, y: 0 }, config: { url: `${base}/notfound` }, retry: { maxAttempts: 3, backoffMs: 1 } },
      ],
      connections: [{ id: 'c', source: 't', sourceHandle: 'main', target: 'h', targetHandle: 'main' }],
    };
    const res = await runWorkflow({ executionId: 'e4', workflowId: 'w', definition: def, registry, services: { http: devHttp } });
    expect(res.status).toBe('failed');
    expect(res.failedNodeId).toBe('h');
    expect(res.steps[1].attempt).toBe(1);
    expect(res.error?.code).toBe('HTTP_ERROR');
  });

  it('can be cancelled while a node is running', async () => {
    const def: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', name: 'Start', position: { x: 0, y: 0 }, config: {} },
        { id: 'h', type: 'data.httpRequest', name: 'Slow', position: { x: 0, y: 0 }, config: { url: `${base}/slow` } },
      ],
      connections: [{ id: 'c', source: 't', sourceHandle: 'main', target: 'h', targetHandle: 'main' }],
    };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const res = await runWorkflow({ executionId: 'e5', workflowId: 'w', definition: def, registry, services: { http: devHttp }, signal: ac.signal });
    expect(res.status).toBe('cancelled');
  });

  it('redacts secrets in logged step data', async () => {
    const res = await runWorkflow({
      executionId: 'e6', workflowId: 'w', definition: {
        schemaVersion: 1,
        nodes: [{ id: 't', type: 'trigger.manual', name: 'Start', position: { x: 0, y: 0 }, config: {} }],
        connections: [],
      }, registry, services: { http: devHttp }, triggerItems: [{ json: { user: 'a', password: 'hunter2', apiKey: 'k' } }],
    });
    expect(JSON.stringify(res.steps[0].outputData)).not.toContain('hunter2');
    expect(JSON.stringify(res.steps[0].outputData)).toContain('[REDACTED]');
  });

  it('rejects Authorization headers typed into the HTTP node', () => {
    const issues = registry.validateNodeConfig({
      id: 'h', type: 'data.httpRequest', name: 'H', position: { x: 0, y: 0 },
      config: { url: 'https://x.test', headers: [{ key: 'Authorization', value: 'Bearer abc' }] },
    });
    expect(issues[0]?.message).toMatch(/credential/);
  });
});

describe('SSRF protection', () => {
  it('classifies private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1', '0.0.0.0']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) expect(isBlockedAddress(ip), ip).toBe(false);
  });
  it('blocks loopback and metadata URLs in production mode', async () => {
    await expect(prodHttp.request({ method: 'GET', url: `${base}/booking/B1` })).rejects.toThrow(/Blocked/);
    await expect(prodHttp.request({ method: 'GET', url: 'http://169.254.169.254/latest/meta-data' })).rejects.toThrow(/Blocked/);
    await expect(prodHttp.request({ method: 'GET', url: 'http://localhost:1/' })).rejects.toThrow(/Blocked/);
    await expect(prodHttp.request({ method: 'GET', url: 'file:///etc/passwd' })).rejects.toThrow(/Only http/);
  });
});
