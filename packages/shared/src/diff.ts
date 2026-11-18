import type { WorkflowDefinition, WorkflowNode } from './workflow.js';

/** What changed between two versions of a workflow, in words people understand. */
export interface DefinitionDiff {
  added: { id: string; name: string; type: string }[];
  removed: { id: string; name: string; type: string }[];
  changed: { id: string; name: string; type: string; changes: { field: string; before: unknown; after: unknown }[] }[];
  links: { added: string[]; removed: string[] };
  /** Number of steps that were only moved on the canvas. */
  moved: number;
  /** True when nothing that affects a run changed. */
  same: boolean;
}

const json = (v: unknown) => JSON.stringify(v ?? null);

function nodeChanges(a: WorkflowNode, b: WorkflowNode) {
  const out: { field: string; before: unknown; after: unknown }[] = [];
  if (a.name !== b.name) out.push({ field: 'Name', before: a.name, after: b.name });
  if ((a.credentialId ?? null) !== (b.credentialId ?? null)) out.push({ field: 'Connection', before: a.credentialId ?? null, after: b.credentialId ?? null });
  if (!!a.disabled !== !!b.disabled) out.push({ field: 'Switched off', before: !!a.disabled, after: !!b.disabled });
  if (json(a.retry) !== json(b.retry)) out.push({ field: 'Retry', before: a.retry ?? null, after: b.retry ?? null });
  if ((a.notes ?? '') !== (b.notes ?? '')) out.push({ field: 'Notes', before: a.notes ?? '', after: b.notes ?? '' });
  const keys = [...new Set([...Object.keys(a.config ?? {}), ...Object.keys(b.config ?? {})])].sort();
  for (const k of keys) {
    if (json(a.config?.[k]) !== json(b.config?.[k])) out.push({ field: k, before: a.config?.[k] ?? null, after: b.config?.[k] ?? null });
  }
  return out;
}

/**
 * Compares two workflow definitions (older → newer). Steps are matched by id,
 * so renaming a step shows as a change, not as remove + add.
 */
export function diffDefinitions(older: Pick<WorkflowDefinition, 'nodes' | 'connections'>, newer: Pick<WorkflowDefinition, 'nodes' | 'connections'>): DefinitionDiff {
  const A = new Map(older.nodes.map((n) => [n.id, n]));
  const B = new Map(newer.nodes.map((n) => [n.id, n]));
  const pick = (n: WorkflowNode) => ({ id: n.id, name: n.name, type: n.type });
  const added = newer.nodes.filter((n) => !A.has(n.id)).map(pick);
  const removed = older.nodes.filter((n) => !B.has(n.id)).map(pick);
  const changed: DefinitionDiff['changed'] = [];
  let moved = 0;
  for (const b of newer.nodes) {
    const a = A.get(b.id);
    if (!a) continue;
    const changes = a.type === b.type ? nodeChanges(a, b) : [{ field: 'Step type', before: a.type, after: b.type }];
    if (changes.length) changed.push({ ...pick(b), changes });
    else if (a.position.x !== b.position.x || a.position.y !== b.position.y) moved++;
  }
  const nameOf = (id: string) => B.get(id)?.name ?? A.get(id)?.name ?? id;
  const key = (c: WorkflowDefinition['connections'][number]) => `${c.source}|${c.sourceHandle}|${c.target}|${c.targetHandle}`;
  const label = (c: WorkflowDefinition['connections'][number]) =>
    `${nameOf(c.source)}${c.sourceHandle && c.sourceHandle !== 'main' ? ` (${c.sourceHandle})` : ''} → ${nameOf(c.target)}`;
  const ka = new Set(older.connections.map(key));
  const kb = new Set(newer.connections.map(key));
  const links = {
    added: newer.connections.filter((c) => !ka.has(key(c))).map(label),
    removed: older.connections.filter((c) => !kb.has(key(c))).map(label),
  };
  return {
    added,
    removed,
    changed,
    links,
    moved,
    same: !added.length && !removed.length && !changed.length && !links.added.length && !links.removed.length,
  };
}
