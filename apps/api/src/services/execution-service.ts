import type {
  ExecutionEvent,
  ExecutionStatus,
  ExecutionStep,
  Item,
  TriggerType,
  Workflow,
  WorkflowDefinition,
} from '@widebed/shared';
import { TERMINAL_STATUSES, WORKFLOW_SCHEMA_VERSION } from '@widebed/shared';
import { createHash } from 'node:crypto';
import type { AgentRunRequest, AgentRunResult, ChatMemoryAccess, NodeRegistry, NodeServices, SafeHttpClient } from '@widebed/nodes';
import { NodeError } from '@widebed/nodes';
import { runWorkflow, validateWorkflow, WorkflowValidationError } from '@widebed/engine';
import type { Repositories, StoredExecution } from '../repositories/types.js';
import type { EventBus } from './event-bus.js';
import type { ExecutionQueue } from './queue.js';
import type { CredentialService } from './credential-service.js';
import { deterministicId, newId, nowIso } from '../lib/ids.js';
import { conflict, HttpError, notFound, unprocessable } from '../lib/http-error.js';

export interface StartExecutionInput {
  workflow: Workflow;
  /** "published" runs the immutable snapshot; "draft" runs a frozen copy of the editor draft. */
  mode: 'published' | 'draft';
  triggerType: TriggerType;
  triggerNodeId?: string;
  triggerItems?: Item[];
  initiatedBy: string | null;
  idempotencyKey?: string | null;
  untilNodeId?: string;
  retryOf?: string | null;
}

export interface ExecutionServiceDeps {
  repos: Repositories;
  registry: NodeRegistry;
  bus: EventBus;
  queue: ExecutionQueue;
  http: SafeHttpClient;
  credentials: CredentialService | null;
  runCode: NodeServices['runCode'];
  timeoutMs: number;
  waitMaxMs: number;
  /** Max size of trigger data + draft definition stored on the execution document. */
  maxPayloadBytes?: number;
}

/**
 * Owns the life-cycle of an execution:
 *   pending → queued → running (⇄ waiting) → success | failed | cancelled
 *
 * `start()` runs in the API. `process()` runs wherever jobs are processed
 * (the same process in dev, worker containers in production). Everything a run
 * needs is stored on the execution document, so they never share memory.
 */
export class ExecutionService {
  private controllers = new Map<string, AbortController>();

  constructor(private deps: ExecutionServiceDeps) {
    deps.bus.onCancelRequest((id) => this.controllers.get(id)?.abort(new Error('cancelled')));
  }

  get queue() {
    return this.deps.queue;
  }

  /** Begin consuming jobs in this process. */
  startWorker() {
    this.deps.queue.startProcessing(
      (id) => this.process(id),
      (id, reason) => this.handleLost(id, reason),
    );
  }

  /* ------------------------------------------------------------------ start */

  async start(input: StartExecutionInput): Promise<{ executionId: string; deduplicated: boolean }> {
    const { repos, registry } = this.deps;
    const wf = input.workflow;

    let definition: WorkflowDefinition;
    let versionNumber: number | null = null;
    let versionId: string | null = null;
    if (input.mode === 'published') {
      if (!wf.publishedVersionId) throw unprocessable('This workflow has not been published yet');
      const version = await repos.versions.get(wf.publishedVersionId);
      if (!version) throw unprocessable('Published version is missing');
      definition = { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes: version.nodes, connections: version.connections, settings: version.settings };
      versionNumber = version.versionNumber;
      versionId = version.versionId;
    } else {
      definition = wf.draftDefinition;
    }

    const triggerNodeId = input.triggerNodeId ?? pickTrigger(definition, registry, input.triggerType);
    if (!triggerNodeId) throw unprocessable('Add a trigger node to start the workflow');

    // Fail fast with a clear message instead of queueing a run that cannot start.
    const blocking = validateWorkflow(definition, registry).filter((i) => i.severity === 'error' && !i.nodeId);
    if (blocking.length) throw unprocessable('Workflow is invalid', blocking);

    const triggerItems = input.triggerItems ?? [];
    const definitionJson = input.mode === 'draft' ? JSON.stringify(definition) : null;
    const size = JSON.stringify(triggerItems).length + (definitionJson?.length ?? 0);
    if (size > (this.deps.maxPayloadBytes ?? 700 * 1024)) throw new HttpError(413, 'Trigger data is too large to start a run');

    // Idempotency: same key for the same workflow → same id; createIfAbsent is atomic.
    const executionId = input.idempotencyKey ? deterministicId('exe', wf.workflowId, input.idempotencyKey) : newId('exe');

    const exec: StoredExecution = {
      executionId,
      workflowId: wf.workflowId,
      workflowName: wf.name,
      department: wf.department,
      workflowVersion: versionNumber,
      workflowVersionId: versionId,
      isTestRun: input.mode === 'draft',
      status: 'pending',
      triggerType: input.triggerType,
      initiatedBy: input.initiatedBy,
      idempotencyKey: input.idempotencyKey ?? null,
      retryOf: input.retryOf ?? null,
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
      duration: null,
      errorSummary: null,
      stepCount: 0,
      triggerItems,
      triggerNodeId,
      definitionJson,
      untilNodeId: input.untilNodeId ?? null,
    };

    if (!(await repos.executions.createIfAbsent(exec))) return { executionId, deduplicated: true };

    try {
      await repos.executions.update(executionId, { status: 'queued' });
      await this.deps.queue.add(executionId);
      this.emit({ type: 'execution.status', executionId, status: 'queued' });
    } catch (err) {
      await repos.executions.update(executionId, { status: 'failed', errorSummary: (err as Error).message, completedAt: nowIso() });
      throw err;
    }
    return { executionId, deduplicated: false };
  }

  /**
   * Called by the scheduler (and /cron/run-schedules) for each occurrence of a Schedule Trigger.
   * Returns the run, or null when the workflow / trigger is no longer active.
   */
  async fireSchedule(workflowId: string, nodeId: string, scheduledFor: string, occurrenceKey: string): Promise<{ executionId: string; deduplicated: boolean } | null> {
    const wf = await this.deps.repos.workflows.get(workflowId);
    if (!wf || wf.status !== 'active' || !wf.publishedVersionId) return null;
    const version = await this.deps.repos.versions.get(wf.publishedVersionId);
    const node = version?.nodes.find((n) => n.id === nodeId && n.type === 'trigger.schedule');
    if (!node) return null;
    return this.start({
      workflow: wf,
      mode: 'published',
      triggerType: 'schedule',
      triggerNodeId: nodeId,
      triggerItems: [{ json: { scheduledFor, timezone: (node.config.timezone as string) ?? null } }],
      initiatedBy: null,
      idempotencyKey: occurrenceKey,
    });
  }

  /* ------------------------------------------------------------------ cancel / retry */

  async cancel(executionId: string): Promise<{ status: 'cancelled' | 'requested' }> {
    const exec = await this.deps.repos.executions.get(executionId);
    if (!exec) throw notFound('Execution not found');
    if (TERMINAL_STATUSES.includes(exec.status)) throw conflict(`Execution already ${exec.status}`);
    if (exec.status === 'pending' || exec.status === 'queued') {
      if (await this.deps.queue.remove(executionId)) {
        await this.finalize(executionId, 'cancelled', 'Cancelled before start', null);
        return { status: 'cancelled' };
      }
    }
    // Without Redis, a run this process doesn't own and that is past its time limit can't still be
    // running: the server that ran it was stopped or paused (e.g. Vercel). Close it now.
    if (this.isAbandoned(exec)) {
      await this.finalize(executionId, 'cancelled', 'Cancelled. The server running it had stopped (it was stuck).', exec.startedAt, exec.stepCount);
      return { status: 'cancelled' };
    }
    // Running (or just picked up): ask whichever process runs it to stop.
    await this.deps.bus.requestCancel(executionId);
    return { status: 'requested' };
  }

  /** In-process mode: not running here and older than the time limit (+2 min) → nobody is running it. */
  private isAbandoned(exec: StoredExecution, now = Date.now()) {
    if (this.deps.queue.mode !== 'in-process' || this.controllers.has(exec.executionId)) return false;
    if (!['pending', 'queued', 'running'].includes(exec.status)) return false;
    const since = Date.parse(exec.startedAt ?? exec.createdAt);
    return Number.isFinite(since) && now - since > this.deps.timeoutMs + 120_000;
  }

  /**
   * Marks runs that were left "running" by a stopped/paused server as failed, so they don't
   * stay "Running" forever. Called by /cron/run-schedules. Returns how many were closed.
   */
  async failAbandoned(now = Date.now()): Promise<number> {
    if (this.deps.queue.mode !== 'in-process') return 0;
    const open = await this.deps.repos.executions.listByStatus(['pending', 'queued', 'running'], 200);
    let n = 0;
    for (const e of open) {
      if (!this.isAbandoned(e, now)) continue;
      await this.finalize(e.executionId, 'failed', 'Stopped: the server running it was paused or restarted before it finished (it went over the time limit).', e.startedAt, e.stepCount);
      n++;
    }
    return n;
  }

  async retry(executionId: string, actorId: string): Promise<{ executionId: string }> {
    const { repos } = this.deps;
    const exec = await repos.executions.get(executionId);
    if (!exec) throw notFound('Execution not found');
    if (exec.status !== 'failed' && exec.status !== 'cancelled') throw conflict('Only failed or cancelled executions can be retried');
    if (exec.isTestRun) throw conflict('Test runs cannot be retried. Run the workflow again from the editor.');
    if (!exec.triggerItems) throw conflict('This execution cannot be retried safely (trigger data was not kept)');
    const wf = await repos.workflows.get(exec.workflowId);
    if (!wf) throw notFound('Workflow no longer exists');
    // Pin the retry to the exact version that failed, not the newest one.
    const pinned: Workflow = { ...wf, publishedVersionId: exec.workflowVersionId, publishedVersion: exec.workflowVersion };
    const res = await this.start({
      workflow: pinned,
      mode: 'published',
      triggerType: 'retry',
      triggerNodeId: exec.triggerNodeId ?? undefined,
      triggerItems: exec.triggerItems,
      initiatedBy: actorId,
      retryOf: exec.executionId,
    });
    return { executionId: res.executionId };
  }

  /**
   * In-process mode only: runs left "queued"/"running" by a previous process
   * cannot resume (the queue lived in memory), so they are marked failed.
   * With Redis, queued jobs survive and stalled ones are handled by handleLost().
   */
  async recoverInterrupted(): Promise<number> {
    if (this.deps.queue.mode !== 'in-process') return 0;
    const stale = await this.deps.repos.executions.listByStatus(['pending', 'queued', 'running', 'waiting'], 500);
    let n = 0;
    for (const e of stale) {
      if (this.controllers.has(e.executionId)) continue;
      await this.deps.repos.executions.update(e.executionId, { status: 'failed', errorSummary: 'Interrupted by a server restart', completedAt: nowIso() });
      n++;
    }
    return n;
  }

  /** BullMQ reports a job that failed outside our code (e.g. the worker process died). */
  async handleLost(executionId: string, reason: string) {
    const e = await this.deps.repos.executions.get(executionId);
    if (!e || TERMINAL_STATUSES.includes(e.status)) return;
    await this.finalize(executionId, 'failed', `The worker stopped during the run (${reason || 'unknown reason'})`, e.startedAt, e.stepCount);
  }

  /* ------------------------------------------------------------------ run */

  private emit(e: ExecutionEvent) {
    this.deps.bus.publish(e);
  }

  private async setStatus(id: string, status: ExecutionStatus) {
    await this.deps.repos.executions.update(id, { status });
    this.emit({ type: 'execution.status', executionId: id, status });
  }

  private async finalize(id: string, status: 'success' | 'failed' | 'cancelled', errorSummary: string | null, startedAt: string | null, stepCount?: number) {
    const completedAt = nowIso();
    const duration = startedAt ? Date.parse(completedAt) - Date.parse(startedAt) : 0;
    await this.deps.repos.executions.update(id, { status, errorSummary, completedAt, duration, ...(stepCount !== undefined ? { stepCount } : {}) });
    this.emit({ type: 'execution.status', executionId: id, status, errorSummary, duration });
    if (status === 'failed' && this.failureHook) void this.failureHook(id).catch(() => undefined);
  }

  private failureHook: ((executionId: string) => Promise<unknown>) | null = null;
  /** Called (without waiting) whenever a run ends as failed. Used for alert emails. */
  onFailure(fn: (executionId: string) => Promise<unknown>) {
    this.failureHook = fn;
  }

  private async loadDefinition(exec: StoredExecution): Promise<WorkflowDefinition> {
    if (exec.isTestRun) {
      if (!exec.definitionJson) throw new Error('Test run has no stored definition');
      return JSON.parse(exec.definitionJson);
    }
    const v = exec.workflowVersionId ? await this.deps.repos.versions.get(exec.workflowVersionId) : null;
    if (!v) throw new Error('Published version is missing');
    return { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes: v.nodes, connections: v.connections, settings: v.settings };
  }

  private agentRunner: ((exec: StoredExecution, req: AgentRunRequest) => Promise<AgentRunResult>) | null = null;
  /** Set by bootstrap once the assistant exists (it needs this service, so it cannot be a constructor argument). */
  setAgentRunner(fn: (exec: StoredExecution, req: AgentRunRequest) => Promise<AgentRunResult>) {
    this.agentRunner = fn;
  }

  private servicesFor(exec: StoredExecution): NodeServices {
    const { credentials, http, runCode, waitMaxMs } = this.deps;
    const dept = exec.department;
    const runner = this.agentRunner;
    let answered = false;
    return {
      agent: runner ? (req) => runner(exec, req) : undefined,
      http,
      runCode,
      firestore: credentials ? (id) => credentials.firestoreAccess(id, dept) : undefined,
      googleToken: credentials ? (id) => credentials.googleToken(id, dept) : undefined,
      ai: credentials ? (id, req) => credentials.ai(id, dept, req) : undefined,
      apiKey: credentials ? (id) => credentials.apiKey(id, dept) : undefined,
      chatMemory: chatMemoryFor(this.deps.repos, exec.workflowId),
      // Only the first answer of a webhook run counts (the caller gets one response).
      respond: exec.triggerType === 'webhook' ? async (r) => {
        if (answered) return;
        answered = true;
        await this.deps.repos.executions.update(exec.executionId, { webhookResponseJson: JSON.stringify(r).slice(0, 1_000_000) });
      } : undefined,
      wait: async (ms, signal) => {
        if (ms > waitMaxMs) throw new NodeError(`Wait is longer than the allowed maximum (${Math.round(waitMaxMs / 60000)} min)`, { code: 'WAIT_TOO_LONG' });
        if (ms <= 0) return;
        await this.setStatus(exec.executionId, 'waiting');
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, ms);
          signal.addEventListener('abort', () => (clearTimeout(t), reject(new NodeError('Cancelled during wait', { code: 'CANCELLED' }))), { once: true });
        });
        await this.setStatus(exec.executionId, 'running');
      },
    };
  }

  /** Queue worker: runs one execution end-to-end. */
  async process(executionId: string) {
    const { repos, registry } = this.deps;
    const exec = await repos.executions.get(executionId);
    if (!exec) return;
    if (exec.status === 'running' || exec.status === 'waiting') {
      // Picked up again after a crash: never re-run nodes that may have had side effects.
      await this.finalize(executionId, 'failed', 'The worker stopped during the run', exec.startedAt, exec.stepCount);
      return;
    }
    if (exec.status !== 'queued' && exec.status !== 'pending') return; // cancelled meanwhile

    const ctrl = new AbortController();
    this.controllers.set(executionId, ctrl);
    const startedAt = nowIso();
    let stepCount = 0;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      const definition = await this.loadDefinition(exec);
      const effectiveTimeout = Math.min(definition.settings?.timeoutMs ?? this.deps.timeoutMs, this.deps.timeoutMs);
      timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort(new Error('timeout'));
      }, effectiveTimeout);

      await repos.executions.update(executionId, { status: 'running', startedAt });
      this.emit({ type: 'execution.status', executionId, status: 'running' });

      const saveStep = async (step: ExecutionStep, kind: 'step.started' | 'step.finished') => {
        await repos.executions.upsertStep(step);
        this.emit({ type: kind, executionId, step: JSON.parse(JSON.stringify(step)) });
      };

      const result = await runWorkflow({
        executionId,
        workflowId: exec.workflowId,
        definition,
        registry,
        services: this.servicesFor(exec),
        triggerNodeId: exec.triggerNodeId ?? undefined,
        triggerItems: exec.triggerItems ?? [],
        untilNodeId: exec.untilNodeId ?? undefined,
        signal: ctrl.signal,
        hooks: {
          onStepStart: (s) => saveStep(s, 'step.started'),
          onStepFinish: (s) => {
            stepCount++;
            return saveStep(s, 'step.finished');
          },
        },
      });

      if (result.status === 'cancelled' && timedOut) {
        await this.finalize(executionId, 'failed', `Execution timed out after ${effectiveTimeout} ms`, startedAt, stepCount);
      } else if (result.status === 'success') {
        await this.finalize(executionId, 'success', null, startedAt, stepCount);
      } else {
        const failed = result.steps.find((s) => s.nodeId === result.failedNodeId);
        const summary = result.status === 'cancelled' ? 'Cancelled by user' : `${failed?.nodeName ?? 'Node'}: ${result.error?.message ?? 'failed'}`;
        await this.finalize(executionId, result.status, summary, startedAt, stepCount);
      }
    } catch (err) {
      const message = err instanceof WorkflowValidationError ? err.message : `Engine error: ${(err as Error).message}`;
      await this.finalize(executionId, 'failed', message.slice(0, 1000), startedAt, stepCount).catch(() => undefined);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(executionId);
    }
  }
}

function pickTrigger(def: WorkflowDefinition, registry: NodeRegistry, triggerType: TriggerType): string | undefined {
  const triggers = def.nodes.filter((n) => registry.get(n.type)?.descriptor.isTrigger);
  const wanted: Record<string, string> = { webhook: 'trigger.webhook', schedule: 'trigger.schedule', http_event: 'trigger.event' };
  // Manual runs prefer a Manual Trigger but can also start any other trigger with its test data.
  return (triggers.find((t) => t.type === (wanted[triggerType] ?? 'trigger.manual')) ?? triggers[0])?.id;
}

/**
 * Conversation memory of AI Chatbot nodes. One document per workflow + conversation id
 * (hashed, so phone numbers or emails are not visible in document ids).
 */
export function chatMemoryFor(repos: Repositories, workflowId: string): ChatMemoryAccess {
  const id = (conversationId: string) => createHash('sha256').update(`${workflowId}\n${conversationId}`).digest('hex').slice(0, 40);
  return {
    async load(conversationId) {
      const doc = await repos.chatMemory.get(id(conversationId));
      return doc && doc.workflowId === workflowId ? doc.turns : [];
    },
    async save(conversationId, turns) {
      await repos.chatMemory.set(id(conversationId), { workflowId, turns, updatedAt: new Date().toISOString() });
    },
    async clear(conversationId) {
      await repos.chatMemory.delete(id(conversationId));
    },
  };
}
