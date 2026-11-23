import type {
  ExecutionStep,
  Item,
  RetryPolicy,
  StepError,
  WorkflowDefinition,
  WorkflowNode,
} from '@widebed/shared';
import { limitSize, redactSecrets } from '@widebed/shared';
import { NodeError, type NodeRegistry, type NodeServices } from '@widebed/nodes';
import { resolveValue, ExpressionError, type ExpressionScope } from './expressions.js';
import { reachableFrom, topologicalOrder, validateWorkflow } from './graph.js';

export interface EngineLimits {
  /** Max items a single node may emit. */
  maxItemsPerNode: number;
  /** Max bytes kept for each step's input / output in the execution log. */
  maxLoggedBytes: number;
}

export const DEFAULT_ENGINE_LIMITS: EngineLimits = { maxItemsPerNode: 5000, maxLoggedBytes: 64 * 1024 };

export interface ExecutionHooks {
  onStepStart?(step: ExecutionStep): void | Promise<void>;
  onStepFinish?(step: ExecutionStep): void | Promise<void>;
}

export interface RunWorkflowOptions {
  executionId: string;
  workflowId: string;
  definition: WorkflowDefinition;
  registry: NodeRegistry;
  services: NodeServices;
  /** Which trigger starts this run. Defaults to the only trigger present. */
  triggerNodeId?: string;
  /** Items handed to the trigger (e.g. the webhook request). */
  triggerItems?: Item[];
  /** Stop after this node (used by "test node" in the editor). */
  untilNodeId?: string;
  signal?: AbortSignal;
  hooks?: ExecutionHooks;
  limits?: Partial<EngineLimits>;
  newStepId?: () => string;
  /** Test hook to avoid real waiting during retry backoff. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RunResult {
  status: 'success' | 'failed' | 'cancelled';
  error: StepError | null;
  failedNodeId: string | null;
  /** Outputs of every executed node (by node id). */
  outputs: Record<string, Record<string, Item[]>>;
  steps: ExecutionStep[];
}

export class WorkflowValidationError extends Error {
  constructor(public readonly issues: { message: string; nodeId?: string }[]) {
    super(`Workflow is invalid: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'WorkflowValidationError';
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });

let counter = 0;
const defaultStepId = () => `step_${Date.now().toString(36)}_${(counter++).toString(36)}`;

function toStepError(err: unknown): StepError {
  if (err instanceof NodeError) return { message: err.message, code: err.code, retryable: err.retryable };
  if (err instanceof ExpressionError) return { message: err.message, code: 'EXPRESSION_ERROR', retryable: false };
  if (err instanceof Error) return { message: err.message, code: 'NODE_ERROR', retryable: false };
  return { message: String(err), code: 'NODE_ERROR', retryable: false };
}

/**
 * Runs a workflow definition to completion.
 *
 * Execution model:
 * - Only nodes reachable from the starting trigger run, in topological order.
 * - Each node receives the items emitted on the output handles connected to it.
 * - A node whose inputs received zero items is "skipped" (e.g. the untaken
 *   branch of an IF), and so are nodes downstream of it.
 * - A failing node stops the run (after its retries are used up).
 */
export async function runWorkflow(opts: RunWorkflowOptions): Promise<RunResult> {
  const limits = { ...DEFAULT_ENGINE_LIMITS, ...opts.limits };
  const sleep = opts.sleep ?? defaultSleep;
  const newStepId = opts.newStepId ?? defaultStepId;
  const signal = opts.signal ?? new AbortController().signal;
  const { definition: def, registry } = opts;

  const issues = validateWorkflow(def, registry).filter((i) => i.severity === 'error');
  // Graph-level problems (cycles, no trigger) always block the run.
  const graphIssues = issues.filter((i) => !i.nodeId);
  if (graphIssues.length) throw new WorkflowValidationError(graphIssues);

  const triggers = def.nodes.filter((n) => registry.get(n.type)?.descriptor.isTrigger);
  const start = opts.triggerNodeId ? triggers.find((t) => t.id === opts.triggerNodeId) : triggers[0];
  if (!start) throw new WorkflowValidationError([{ message: `Trigger node "${opts.triggerNodeId}" not found` }]);
  if (!opts.triggerNodeId && triggers.length > 1) {
    // Several triggers: caller must say which one fired.
    throw new WorkflowValidationError([{ message: 'Workflow has several triggers; specify which trigger started the run' }]);
  }

  const reachable = reachableFrom(def, start.id);
  if (opts.untilNodeId) {
    // "Test this node": run only the target and the nodes that lead to it.
    if (!reachable.has(opts.untilNodeId)) {
      throw new WorkflowValidationError([{ message: 'This node is not connected to the trigger', nodeId: opts.untilNodeId }]);
    }
    const ancestors = ancestorsOf(def, opts.untilNodeId);
    for (const id of [...reachable]) if (!ancestors.has(id)) reachable.delete(id);
  }
  // Node problems only block the run if the node would actually execute,
  // so a half-finished draft branch does not prevent testing the rest.
  const nodeIssues = issues.filter((i) => i.nodeId && reachable.has(i.nodeId));
  if (nodeIssues.length) throw new WorkflowValidationError(nodeIssues);

  const order = topologicalOrder(def, def.nodes.filter((n) => reachable.has(n.id)).map((n) => n.id))!;
  const nodesById = new Map(def.nodes.map((n) => [n.id, n]));

  const outputs: Record<string, Record<string, Item[]>> = {};
  const firstJson: ExpressionScope['nodes'] = {};
  const steps: ExecutionStep[] = [];
  const result: RunResult = { status: 'success', error: null, failedNodeId: null, outputs, steps };

  const log = (v: unknown) => limitSize(redactSecrets(v), limits.maxLoggedBytes);

  for (const nodeId of order) {
    const node = nodesById.get(nodeId)!;
    const impl = registry.get(node.type)!;

    if (signal.aborted) {
      result.status = 'cancelled';
      result.error = { message: 'Execution cancelled' };
      break;
    }

    // Gather input items per input handle.
    const inputs: Record<string, Item[]> = {};
    let incoming = 0;
    if (node.id === start.id) {
      inputs.main = opts.triggerItems ?? [];
    } else {
      for (const c of def.connections) {
        if (c.target !== node.id || !outputs[c.source]) continue;
        incoming++;
        (inputs[c.targetHandle] ??= []).push(...(outputs[c.source][c.sourceHandle] ?? []));
      }
    }
    const items = inputs.main ?? [];
    const totalItems = Object.values(inputs).reduce((n, list) => n + list.length, 0);

    const step: ExecutionStep = {
      stepId: newStepId(),
      executionId: opts.executionId,
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      status: 'running',
      attempt: 1,
      inputData: log(items.map((i) => i.json)),
      outputData: null,
      error: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      duration: null,
    };

    // Not the trigger and nothing arrived → skip (branch not taken).
    if (node.id !== start.id && (incoming === 0 || totalItems === 0)) {
      step.status = 'skipped';
      step.completedAt = step.startedAt;
      step.duration = 0;
      steps.push(step);
      await opts.hooks?.onStepFinish?.(step);
      continue;
    }

    await opts.hooks?.onStepStart?.(step);
    const t0 = Date.now();

    if (node.disabled) {
      outputs[node.id] = { main: items };
      firstJson[node.id] = firstJson[node.name] = items[0]?.json;
      finish(step, 'success', t0, log({ passthrough: true, items: items.map((i) => i.json) }));
      steps.push(step);
      await opts.hooks?.onStepFinish?.(step);
      continue;
    }

    const config = impl.configSchema.parse(node.config ?? {});
    const policy: RetryPolicy = node.retry ?? def.settings?.defaultRetry ?? { maxAttempts: 1, backoffMs: 0 };
    const retryAllowed = impl.descriptor.retryable || node.retry !== undefined;
    const maxAttempts = retryAllowed ? Math.max(1, Math.min(policy.maxAttempts, 10)) : 1;

    const scopeBase: Omit<ExpressionScope, 'item' | 'itemIndex'> = {
      nodes: firstJson,
      allItems: (name) => {
        const id = nodesById.has(name) ? name : def.nodes.find((x) => x.name === name)?.id;
        return id ? outputs[id]?.main?.map((i) => i.json) : undefined;
      },
      trigger: outputs[start.id]?.main?.[0]?.json,
      executionId: opts.executionId,
      workflowId: opts.workflowId,
    };

    let lastError: StepError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      step.attempt = attempt;
      try {
        const res = await impl.execute({
          executionId: opts.executionId,
          workflowId: opts.workflowId,
          node,
          config,
          items,
          inputs,
          resolve: (value, item, itemIndex) => resolveValue(value, { ...scopeBase, item, itemIndex }),
          signal,
          services: opts.services,
          log: () => undefined,
        });
        checkOutputs(node, res.outputs, limits.maxItemsPerNode);
        outputs[node.id] = res.outputs;
        const first = Object.values(res.outputs).find((l) => l.length)?.[0]?.json;
        firstJson[node.id] = first;
        firstJson[node.name] = first;
        lastError = null;
        finish(step, 'success', t0, log(Object.fromEntries(Object.entries(res.outputs).map(([h, l]) => [h, l.map((i) => i.json)]))));
        break;
      } catch (err) {
        lastError = toStepError(err);
        if (signal.aborted) break;
        const canRetry = attempt < maxAttempts && lastError.retryable !== false;
        if (!canRetry) break;
        try {
          await sleep(policy.backoffMs * 2 ** (attempt - 1), signal);
        } catch {
          break; // cancelled while waiting
        }
      }
    }

    if (lastError) {
      const cancelled = signal.aborted;
      finish(step, cancelled ? 'cancelled' : 'failed', t0, null, lastError);
      steps.push(step);
      await opts.hooks?.onStepFinish?.(step);
      result.status = cancelled ? 'cancelled' : 'failed';
      result.error = cancelled ? { message: 'Execution cancelled' } : lastError;
      result.failedNodeId = cancelled ? null : node.id;
      break;
    }
    steps.push(step);
    await opts.hooks?.onStepFinish?.(step);
  }

  return result;
}

function ancestorsOf(def: WorkflowDefinition, nodeId: string): Set<string> {
  const seen = new Set<string>([nodeId]);
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const c of def.connections) {
      if (c.target === id && !seen.has(c.source)) {
        seen.add(c.source);
        stack.push(c.source);
      }
    }
  }
  return seen;
}

function finish(step: ExecutionStep, status: ExecutionStep['status'], t0: number, output: unknown, error: StepError | null = null) {
  step.status = status;
  step.outputData = output;
  step.error = error;
  step.completedAt = new Date().toISOString();
  step.duration = Date.now() - t0;
}

function checkOutputs(node: WorkflowNode, out: Record<string, Item[]>, max: number) {
  if (!out || typeof out !== 'object') throw new NodeError(`${node.name} returned no outputs`);
  for (const [handle, list] of Object.entries(out)) {
    if (!Array.isArray(list)) throw new NodeError(`${node.name} output "${handle}" is not a list of items`);
    if (list.length > max) throw new NodeError(`${node.name} produced ${list.length} items (limit ${max})`, { code: 'ITEM_LIMIT' });
  }
}
