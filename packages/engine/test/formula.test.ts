import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@widebed/shared';
import { createDefaultRegistry, type NodeServices } from './helpers.js';
import { resolveValue, runWorkflow } from '../src/index.js';

const scope = {
  item: { json: { name: 'ana lee', total: 120, rooms: [{ name: 'A-12', beds: 2 }, { name: 'B-03', beds: 1 }], date: '01/12/2026', phone: '+60 12-345 6789', empty: '' } },
  itemIndex: 0,
  nodes: { Webhook: { body: { full_name: 'Ana Lee', message: { body: 'Hi' }, customData: { id: 'c1' } } }, w1: { body: {} }, 'System Prompt': { 'System Prompt:': 'You are Willow' } },
  allItems: (n: string) => (n === 'Rows' ? [{ n: 1 }, { n: 2 }, { n: 3 }] : undefined),
  executionId: 'exe_1',
  workflowId: 'wf_1',
  now: () => '2026-11-20T08:30:00.000Z', // 16:30 in Malaysia
};
scope.nodes = { ...scope.nodes, Rows: { n: 1 } } as any;
const r = (t: string) => resolveValue(t, scope as any);

describe('n8n-style formulas', () => {
  it('keeps simple paths working exactly as before', () => {
    expect(r('{{ $json.total }}')).toBe(120);
    expect(r('{{ $node["Webhook"].json.body.full_name }}')).toBe('Ana Lee');
    expect(r('{{ $node["Webhook"].body.customData.id }}')).toBe('c1');
    expect(r('{{ $today }}')).toBe('2026-11-20');
    expect(r('{{ $now }}')).toBe('2026-11-20T08:30:00.000Z');
  });

  it('runs the formulas people write in n8n', () => {
    expect(r("{{ $('Webhook').item.json.body.full_name }}")).toBe('Ana Lee');
    expect(r("{{ $('Webhook').first().json.body.message.body }}")).toBe('Hi');
    expect(r("{{ $('System Prompt').first().json['System Prompt:'] }}")).toBe('You are Willow');
    expect(r("{{ $('Rows').all().length }}")).toBe(3);
    expect(r("{{ $('Rows').last().json.n }}")).toBe(3);
    expect(r("{{ $now.format('yyyy-MM-dd') }}")).toBe('2026-11-20');
    expect(r("{{ $now.toFormat('d MMM yyyy, h:mm a') }}")).toBe('20 Nov 2026, 4:30 PM');
    expect(r("{{ $now.plus(3, 'days').format('EEEE d MMMM') }}")).toBe('Monday 23 November');
    expect(r("{{ $now.minus({ months: 1 }).format('MMM yyyy') }}")).toBe('Oct 2026');
    expect(r("{{ $today.plus(1, 'day').toISODate() }}")).toBe('2026-11-21');
    expect(r('{{ $today.weekday }}')).toBe('Friday');
    expect(r('{{ $json.date.toDateTime().toFormat("dd MMM") }}')).toBe('01 Dec');
    expect(r("{{ $json.date.toDateTime().diff($today, 'days') }}")).toBe(11);
  });

  it('handles text, numbers, lists, operators and arrow functions', () => {
    expect(r('{{ $json.name.toUpperCase() }}')).toBe('ANA LEE');
    expect(r("{{ $json.name.split(' ')[0] }}")).toBe('ana');
    expect(r('{{ $json.name.toTitleCase() }}')).toBe('Ana Lee');
    expect(r("Hi {{ $json.name.split(' ')[0].toTitleCase() }}!")).toBe('Hi Ana!');
    expect(r("{{ $json.total > 100 ? 'big' : 'small' }}")).toBe('big');
    expect(r('{{ ($json.total * 1.06).toFixed(2) }}')).toBe('127.20');
    expect(r("{{ $json.rooms.map(r => r.name).join(', ') }}")).toBe('A-12, B-03');
    expect(r('{{ $json.rooms.filter(r => r.beds > 1).length }}')).toBe(1);
    expect(r('{{ $json.rooms.map(r => r.beds).sum() }}')).toBe(3);
    expect(r('{{ $json.missing?.name ?? "none" }}')).toBe('none');
    expect(r("{{ $json.empty || 'fallback' }}")).toBe('fallback');
    expect(r("{{ $json.phone.replaceAll(' ', '').replaceAll('-', '') }}")).toBe('+60123456789');
    expect(r('{{ `Room ${$json.rooms[0].name} for ${$json.name}` }}')).toBe('Room A-12 for ana lee');
    expect(r('{{ Math.round(2.6) + Math.max(1, 5) }}')).toBe(8);
    expect(r('{{ JSON.stringify({ a: 1, b: [2] }) }}')).toBe('{"a":1,"b":[2]}');
    expect(r('{{ Object.keys($json.rooms[0]).join("|") }}')).toBe('name|beds');
    expect(r('{{ $itemIndex + 1 }}')).toBe(1);
    expect(r('{{ { guest: $json.name, n: 2 } }}')).toEqual({ guest: 'ana lee', n: 2 });
  });

  it('stays in its box: no prototypes, globals, eval, or endless work', () => {
    const bad = [
      '{{ $json.constructor.constructor("return process")() }}',
      '{{ $json.name.constructor }}',
      '{{ $json.__proto__ }}',
      "{{ $json['__proto__'] }}",
      '{{ process.env }}',
      '{{ globalThis }}',
      '{{ require("fs") }}',
      '{{ eval("1") }}',
      '{{ new Date() }}',
      '{{ this }}',
      '{{ Function("return 1")() }}',
      '{{ $json.name.toUpperCase.call("x") }}',
      '{{ Math.round.constructor("return process")() }}',
    ];
    for (const b of bad) {
      let v: unknown;
      try {
        v = r(b);
      } catch {
        continue;
      }
      expect({ b, v }).toEqual({ b, v: undefined });
    }
    expect(() => r("{{ 'x'.repeat(10000000).repeat(10000000) }}")).toThrow(/too long/);
    expect(() => r('{{ $json.rooms.map(a => $json.rooms.map(b => $json.rooms.map(c => [a,b,c]))) }}')).not.toThrow();
    const many = Array.from({ length: 5000 }, (_, i) => i);
    expect(() => resolveValue('{{ $json.l.map(a => $json.l.map(b => a + b).length).length }}', { ...scope, item: { json: { l: many } } } as any)).toThrow(/too long|too many steps/);
  });

  it('explains mistakes in plain words', () => {
    expect(() => r('{{ $json.name.shout() }}')).toThrow(/Texts have no \.shout\(\)/);
    expect(() => r("{{ $('Nope').item.json.x }}")).toThrow(/no step called “Nope”/);
    expect(() => r('{{ $json.missing.toUpperCase() }}')).toThrow(/empty value/);
    expect(() => r('{{ $json.name + }}')).toThrow();
    expect(() => r('{{ foo }}')).toThrow(/Unknown variable “foo”/);
  });

  it('works inside a running workflow, with all items of earlier steps', async () => {
    const registry = createDefaultRegistry();
    const def: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', name: 'Start', position: { x: 0, y: 0 }, config: {} },
        { id: 'f', type: 'logic.filter', name: 'Big ones', position: { x: 0, y: 0 }, config: { conditions: [{ left: '{{ $json.total * 2 }}', operator: 'greaterThan', right: '{{ 150 }}' }] } },
        { id: 'c', type: 'logic.combine', name: 'List', position: { x: 0, y: 0 }, config: { line: "{{ $json.name.toUpperCase() }} ({{ $('Start').all().length }} in total)" } },
      ],
      connections: [
        { id: 'a', source: 't', sourceHandle: 'main', target: 'f', targetHandle: 'main' },
        { id: 'b', source: 'f', sourceHandle: 'main', target: 'c', targetHandle: 'main' },
      ],
      settings: {},
    };
    const res = await runWorkflow({ executionId: 'e', workflowId: 'w', definition: def, registry, services: { http: { request: async () => { throw new Error('no'); } } } as unknown as NodeServices, triggerItems: [{ json: { name: 'a', total: 100 } }, { json: { name: 'b', total: 50 } }, { json: { name: 'c', total: 80 } }] });
    expect(res.status).toBe('success');
    expect(res.outputs.c!.main![0]!.json.list).toBe('A (3 in total)\nC (3 in total)');
  });
});
