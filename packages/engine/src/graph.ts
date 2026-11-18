import type { ValidationIssue, WorkflowDefinition, WorkflowNode } from '@widebed/shared';
import { resolveOutputs } from '@widebed/shared';
import type { NodeRegistry } from '@widebed/nodes';

export interface GraphLimits {
  maxNodes: number;
}

export const DEFAULT_GRAPH_LIMITS: GraphLimits = { maxNodes: 200 };

/**
 * Validates the workflow graph: node types, configs, handles, duplicate
 * names, exactly-one-trigger reachability, and cycles.
 */
export function validateWorkflow(
  def: WorkflowDefinition,
  registry: NodeRegistry,
  limits: GraphLimits = DEFAULT_GRAPH_LIMITS,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (message: string, nodeId?: string) => issues.push({ message, nodeId, severity: 'error' });
  const warn = (message: string, nodeId?: string) => issues.push({ message, nodeId, severity: 'warning' });

  if (!def || !Array.isArray(def.nodes) || !Array.isArray(def.connections)) {
    err('Workflow definition is malformed');
    return issues;
  }
  if (def.nodes.length > limits.maxNodes) err(`A workflow can have at most ${limits.maxNodes} nodes`);

  const byId = new Map<string, WorkflowNode>();
  const names = new Set<string>();
  for (const node of def.nodes) {
    if (byId.has(node.id)) err(`Duplicate node id "${node.id}"`, node.id);
    byId.set(node.id, node);
    if (names.has(node.name)) err(`Node name "${node.name}" is used more than once`, node.id);
    names.add(node.name);
    issues.push(...registry.validateNodeConfig(node));
    const d = registry.get(node.type)?.descriptor;
    if (node.type === 'util.unsupported') {
      issues.push({ nodeId: node.id, message: `${node.name}: imported node “${String(node.config?.originalType ?? '')}” is not supported yet — replace it`, severity: 'error' });
    }
    if (d?.credentialProvider && !node.credentialId) {
      issues.push({ nodeId: node.id, field: 'credentialId', message: `${node.name}: choose a connection (Credentials)`, severity: 'error' });
    }
  }

  const triggers = def.nodes.filter((n) => registry.get(n.type)?.descriptor.isTrigger);
  if (triggers.length === 0) err('Add a trigger node to start the workflow');

  for (const c of def.connections) {
    const s = byId.get(c.source);
    const t = byId.get(c.target);
    if (!s || !t) {
      err(`Connection ${c.id} points to a missing node`);
      continue;
    }
    const sd = registry.get(s.type)?.descriptor;
    const td = registry.get(t.type)?.descriptor;
    if (sd && !resolveOutputs(sd, s.config).some((h) => h.id === c.sourceHandle)) err(`"${s.name}" has no output "${c.sourceHandle}" (was a case removed?)`, s.id);
    if (td && !td.inputs.some((h) => h.id === c.targetHandle)) err(`"${t.name}" has no input "${c.targetHandle}"`, t.id);
    if (td?.isTrigger) err(`Trigger "${t.name}" cannot have incoming connections`, t.id);
    if (c.source === c.target) err(`"${s.name}" is connected to itself`, s.id);
  }

  if (hasCycle(def)) err('The workflow contains a loop of connections. Use the Loop node (Phase 2) for repetition.');

  // Nodes that no trigger can reach will never run.
  const reachable = new Set<string>();
  for (const t of triggers) for (const id of reachableFrom(def, t.id)) reachable.add(id);
  for (const n of def.nodes) {
    if (!reachable.has(n.id)) warn(`"${n.name}" is not connected to a trigger and will never run`, n.id);
  }
  return issues;
}

export function hasCycle(def: WorkflowDefinition): boolean {
  return topologicalOrder(def, def.nodes.map((n) => n.id)) === null;
}

export function reachableFrom(def: WorkflowDefinition, startId: string): Set<string> {
  const seen = new Set<string>([startId]);
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const c of def.connections) {
      if (c.source === id && !seen.has(c.target)) {
        seen.add(c.target);
        stack.push(c.target);
      }
    }
  }
  return seen;
}

/** Kahn's algorithm restricted to `ids`. Returns null if there is a cycle. */
export function topologicalOrder(def: WorkflowDefinition, ids: string[]): string[] | null {
  const set = new Set(ids);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const c of def.connections) {
    if (set.has(c.source) && set.has(c.target)) indeg.set(c.target, (indeg.get(c.target) ?? 0) + 1);
  }
  // Stable order: keep the order nodes appear in the definition.
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const c of def.connections) {
      if (c.source !== id || !set.has(c.target)) continue;
      const d = (indeg.get(c.target) ?? 0) - 1;
      indeg.set(c.target, d);
      if (d === 0) queue.push(c.target);
    }
  }
  return order.length === ids.length ? order : null;
}
