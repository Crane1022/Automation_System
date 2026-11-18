import crypto from 'node:crypto';
import {
  ISSUES_INSTRUCTION,
  describeSchedule,
  extractIssues,
  hasPermission,
  type AgentOpenIssue,
  type AgentResponsibility,
  type AgentResponsibilityView,
  type AgentSchedule,
  type AgentScheduleRule,
  type AgentScheduleView,
  type AgentTask,
  type AgentTaskPriority,
  type AiAgent,
  type AppUser,
  type WorkflowVersion,
} from '@widebed/shared';
import { scheduleTriggerSchema } from '@widebed/nodes';
import type { Repositories } from '../repositories/types.js';
import type { ExecutionQueue } from '../services/queue.js';
import type { EventBus } from '../services/event-bus.js';
import { nextRun, type Scheduler } from '../services/scheduler.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http-error.js';
import { newId, nowIso } from '../lib/ids.js';
import { packTranscript, type AssistantService } from './service.js';
import type { NotificationService } from '../services/notifications.js';
import type { ApprovalService } from './approvals.js';
import type { TranscriptEntry } from './agent.js';
import { Delegation } from './delegation.js';

/** Schedules of AI staff share the workflow scheduler under this prefix. */
export const AI_SCHEDULE_PREFIX = 'ai-';

export interface AgentTaskDeps {
  repos: Repositories;
  assistant: AssistantService;
  queue: ExecutionQueue;
  scheduler: Scheduler;
  bus: EventBus;
  timeoutMs: number;
  notifications: NotificationService;
  approvals: ApprovalService;
  /** Test hook: wait between automatic retries. */
  retryDelayMs?: number;
}

const MAX_OUTPUT = 40_000;
const errMsg = (e: unknown) => (e as Error)?.message ?? String(e);

/**
 * AI Staff background work: one-time tasks and schedules.
 *
 * - A task is stored first, then queued (Redis when available), and run by a worker —
 *   no browser or chat needs to stay open.
 * - Each schedule occurrence makes exactly one task (its id comes from the occurrence key).
 * - A task runs with the permissions of a real person (`runAsId`), never more.
 * - Risky actions are refused in background runs (no one is there to approve) until the
 *   Approval Center (Phase 5) can hold them for a decision.
 */
export class AgentTaskService {
  private running = new Map<string, AbortController>();

  constructor(private d: AgentTaskDeps) {
    d.bus.onCancelRequest((id) => this.running.get(id)?.abort(new Error('cancelled')));
    d.approvals.onDecision('task', (a, approved) => this.continueAfterDecision(a, approved));
    this.delegation = new Delegation({
      repos: d.repos,
      agents: d.assistant.agents,
      newTask: (agent, o) => {
        // One attempt: the manager decides whether to try again (its second hand-off).
        const t = this.newTask(agent, { instructions: o.instructions, title: o.title, priority: 'normal', source: 'delegation', runAsId: o.runAsId, createdBy: o.runAsId, maxAttempts: 1 });
        return { ...t, parentTaskId: o.parentTaskId, projectId: o.projectId, dependsOn: o.dependsOn, toolLimit: o.toolLimit };
      },
      run: (id) => this.run(id),
      stop: (id) => this.running.get(id)?.abort(new Error('cancelled')),
    });
    d.assistant.useDelegation((user, manager, origin) => this.delegation.tools(user, manager, origin));
  }

  readonly delegation: Delegation;

  /** The Approval Center decided (or the request expired): the task carries on, or stops. */
  private async continueAfterDecision(a: import('@widebed/shared').AgentApproval, approved: boolean) {
    if (!a.taskId) return;
    const t = await this.d.repos.agentTasks.get(a.taskId);
    if (!t || t.status !== 'waiting_approval' || t.approvalId !== a.approvalId) return;
    const who = a.decidedBy ? (await this.d.repos.users.get(a.decidedBy))?.name ?? 'An approver' : null;
    if (a.status === 'expired') {
      await this.finish(t, 'failed', { error: 'Nobody approved the request in time, so it expired. Nothing was done. Press “Run again” to start over.', approvalId: null, resume: null, transcriptJson: null });
      return;
    }
    const steps = [...t.steps, { label: approved ? `Approved by ${who}: ${a.toolLabel}` : `Not approved by ${who}${a.note ? ` (“${a.note}”)` : ''}: ${a.toolLabel}`, status: approved ? ('done' as const) : ('error' as const), at: nowIso() }];
    await this.d.repos.agentTasks.update(t.taskId, { status: 'queued', steps, resume: { tool: a.tool, input: a.input, approved, approvalId: a.approvalId } });
    await this.enqueue({ ...t, status: 'queued' });
  }

  private get reg() {
    return this.d.assistant.agents;
  }

  /* ---------------------------------------------------------------- access */

  /** Admins see everything; managers of an AI employee see its tasks; department managers their department's; everyone their own. */
  private async canSeeTask(user: AppUser, t: AgentTask, agents?: Map<string, AiAgent>) {
    if (this.reg.canManage(user)) return true;
    if (t.runAsId === user.uid || t.createdBy === user.uid) return true;
    if (hasPermission(user, 'execution.viewDepartment') && user.department && t.department === user.department) return true;
    const a = agents?.get(t.agentId) ?? (await this.d.repos.agents.get(t.agentId));
    return !!a && this.reg.canEdit(user, a);
  }

  async list(user: AppUser, f: { agentId?: string; status?: string; source?: string; scheduleId?: string; since?: string } = {}) {
    const agents = new Map((await this.reg.listAll()).map((a) => [a.agentId, a]));
    const out: AgentTask[] = [];
    for (const t of await this.d.repos.agentTasks.listRecent(1000)) {
      if (f.agentId && t.agentId !== f.agentId) continue;
      if (f.status && t.status !== f.status) continue;
      if (f.source && t.source !== f.source) continue;
      if (f.scheduleId && t.scheduleId !== f.scheduleId) continue;
      if (f.since && t.createdAt < f.since) continue;
      if (await this.canSeeTask(user, t, agents)) out.push(t);
      if (out.length >= 300) break;
    }
    return out;
  }

  async get(user: AppUser, taskId: string) {
    const t = await this.d.repos.agentTasks.get(taskId);
    if (!t || !(await this.canSeeTask(user, t))) throw notFound('Task not found');
    return t;
  }

  /* ------------------------------------------------------------ one-time task */

  /** "Give a task": anyone who may chat with the AI employee, running with their own permissions. */
  async create(user: AppUser, input: { agentId: string; instructions: string; title?: string; priority?: AgentTaskPriority }) {
    const agent = await this.reg.getForChat(user, input.agentId);
    const problem = await this.d.assistant.agentProblem(user, agent);
    if (problem) throw badRequest(problem);
    const t = this.newTask(agent, { instructions: input.instructions, title: input.title, priority: input.priority ?? 'normal', source: 'manual', runAsId: user.uid, createdBy: user.uid, maxAttempts: 1 });
    await this.d.repos.agentTasks.create(t);
    await this.enqueue(t);
    return t;
  }

  private newTask(agent: AiAgent, o: { instructions: string; title?: string; priority: AgentTaskPriority; source: AgentTask['source']; runAsId: string; createdBy: string; maxAttempts: number; scheduleId?: string; occurrenceKey?: string; taskId?: string }): AgentTask {
    const instructions = o.instructions.trim().slice(0, 4000);
    if (!instructions) throw badRequest('Describe the task');
    return {
      taskId: o.taskId ?? newId('task'),
      agentId: agent.agentId,
      agentName: agent.name,
      title: (o.title?.trim() || instructions.replace(/\s+/g, ' ')).slice(0, 100),
      instructions,
      source: o.source,
      scheduleId: o.scheduleId ?? null,
      runAsId: o.runAsId,
      createdBy: o.createdBy,
      department: agent.department,
      priority: o.priority,
      status: 'queued',
      attempt: 1,
      maxAttempts: o.maxAttempts,
      steps: [],
      output: null,
      error: null,
      files: [],
      inputTokens: 0,
      outputTokens: 0,
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
      durationMs: null,
      occurrenceKey: o.occurrenceKey ?? null,
    };
  }

  private async enqueue(t: AgentTask) {
    try {
      await this.d.queue.add(t.taskId);
    } catch (err) {
      await this.d.repos.agentTasks.update(t.taskId, { status: 'failed', error: `Could not queue the task: ${errMsg(err)}`, completedAt: nowIso() });
      throw err;
    }
  }

  async cancel(user: AppUser, taskId: string) {
    const t = await this.get(user, taskId);
    if (t.runAsId !== user.uid && !this.reg.canManage(user)) {
      const a = await this.d.repos.agents.get(t.agentId);
      if (!a || !this.reg.canEdit(user, a)) throw forbidden('Only the person who gave the task, its managers or an Admin can stop it');
    }
    if (t.status === 'waiting_approval') {
      if (t.approvalId) await this.d.approvals.withdraw(t.approvalId, 'The task was stopped');
      await this.finish(t, 'cancelled', { error: 'Stopped while waiting for approval', approvalId: null, resume: null, transcriptJson: null });
    } else if (t.status === 'queued') {
      await this.d.queue.remove(taskId).catch(() => false);
      await this.d.repos.agentTasks.update(taskId, { status: 'cancelled', completedAt: nowIso(), error: 'Cancelled before it started' });
    } else if (t.status === 'running') {
      this.running.get(taskId)?.abort(new Error('cancelled'));
      await this.d.bus.requestCancel(taskId);
    } else throw conflict('This task has already finished');
  }

  /** Runs a failed or cancelled task again (same instructions, same permissions). */
  async retry(user: AppUser, taskId: string) {
    const t = await this.get(user, taskId);
    if (t.runAsId !== user.uid && !this.reg.canManage(user)) throw forbidden('Only the person who gave the task or an Admin can run it again');
    if (t.status !== 'failed' && t.status !== 'cancelled') throw conflict('Only failed or cancelled tasks can be run again');
    await this.d.repos.agentTasks.update(taskId, { status: 'queued', attempt: t.attempt + 1, error: null, output: null, steps: [], files: [], startedAt: null, completedAt: null, durationMs: null, transcriptJson: null, resume: null, approvalId: null });
    await this.enqueue({ ...t, status: 'queued' });
  }

  /* -------------------------------------------------------------- running */

  startWorker() {
    // Requests nobody answered in time expire (and their tasks stop) even if nobody opens the page.
    setInterval(() => void this.d.approvals.sweep().catch(() => undefined), 60_000).unref?.();
    this.d.queue.startProcessing(
      (id) => this.run(id),
      async (id, reason) => {
        const t = await this.d.repos.agentTasks.get(id);
        if (t && (t.status === 'running' || t.status === 'queued')) await this.finish(t, 'failed', { error: `The worker stopped while running this task (${reason}). Press Retry.` });
      },
    );
  }

  /** Tasks left "running" by a server that stopped (in-process mode): mark them failed. */
  async recoverInterrupted() {
    let n = 0;
    for (const t of await this.d.repos.agentTasks.listByStatus(['running', 'queued'], 500)) {
      const age = Date.now() - Date.parse(t.startedAt ?? t.createdAt);
      if (this.d.queue.mode === 'in-process' || age > this.d.timeoutMs + 60_000) {
        await this.finish(t, 'failed', { error: 'Interrupted by a server restart. Press Retry to run it again.' });
        n++;
      }
    }
    return n;
  }

  private async finish(t: AgentTask, status: AgentTask['status'], patch: Partial<AgentTask>) {
    const completedAt = nowIso();
    const durationMs = t.startedAt ? Date.parse(completedAt) - Date.parse(t.startedAt) : null;
    await this.d.repos.agentTasks.update(t.taskId, { status, completedAt, durationMs, ...patch });
    if (t.scheduleId) await this.d.repos.agentSchedules.update(t.scheduleId, { lastStatus: status, lastTaskId: t.taskId }).catch(() => undefined);
    const done = { ...t, ...patch, status, completedAt, durationMs } as AgentTask;
    try {
      // Only the responsibility's own scheduled runs update its problem list (not follow-ups).
      if (status === 'completed' && done.responsibilityId && done.source === 'schedule') await this.trackIssues(done);
      await this.tell(done);
    } catch (err) {
      console.error('[agent-tasks] after finishing:', errMsg(err));
    }
  }

  /* ------------------------------------------------------- notifications */

  /** Who should hear about a finished task (everyone here may already see it). */
  private async audience(t: AgentTask, mode: 'failures' | 'always' | 'off') {
    if (mode === 'off') return [];
    const a = await this.d.repos.agents.get(t.agentId);
    return [t.runAsId, t.createdBy, ...(t.source === 'manual' ? [] : a?.managerIds ?? [])];
  }

  private async tell(t: AgentTask) {
    if (t.status !== 'completed' && t.status !== 'failed') return;
    if (t.source === 'delegation') return; // the manager reports back instead
    let mode: 'failures' | 'always' | 'off' = 'always';
    if (t.source === 'schedule' && t.scheduleId) mode = (await this.d.repos.agentSchedules.get(t.scheduleId))?.notify ?? 'failures';
    if (mode === 'failures' && t.status !== 'failed') return;
    const who = await this.audience(t, mode);
    const first = (t.output ?? '').replace(/[#*_`>|-]/g, ' ').replace(/\s+/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
    await this.d.notifications.notify(who, {
      kind: t.status === 'completed' ? 'task.completed' : 'task.failed',
      title: t.status === 'completed' ? `${t.agentName} finished “${t.title}”` : `“${t.title}” failed`,
      body: t.status === 'completed' ? first.slice(0, 160) || 'Done.' : t.error ?? 'Something went wrong.',
      link: `/ai-tasks?task=${t.taskId}`,
      agentId: t.agentId,
    });
  }

  /* ---------------------------------------------- responsibilities: issues */

  /**
   * After a responsibility run: new problems are added (and get one follow-up task if
   * wanted), problems seen again are counted, problems no longer reported are resolved.
   */
  private async trackIssues(t: AgentTask) {
    const r = await this.d.repos.responsibilities.get(t.responsibilityId!);
    if (!r) return;
    const reported = t.issues ?? [];
    const now = nowIso();
    const before = new Map(r.openIssues.map((i) => [i.key, i]));
    const open: AgentOpenIssue[] = [];
    const fresh: AgentOpenIssue[] = [];
    for (const rep of reported) {
      const old = before.get(rep.key);
      if (old) open.push({ ...old, text: rep.text, lastSeenAt: now, seenCount: old.seenCount + 1 });
      else {
        const issue: AgentOpenIssue = { key: rep.key, text: rep.text, firstSeenAt: now, lastSeenAt: now, seenCount: 1, firstTaskId: t.taskId, followUpTaskId: null };
        open.push(issue);
        fresh.push(issue);
      }
    }
    const solved = r.openIssues.filter((i) => !reported.some((x) => x.key === i.key)).map((i) => ({ ...i, resolvedAt: now }));

    // One follow-up per NEW problem (never again for the same problem while it stays open), at most 3 per run.
    if (r.autoFollowUp && r.status === 'active' && t.source === 'schedule') {
      const agent = await this.d.repos.agents.get(t.agentId);
      for (const issue of fresh.slice(0, 3)) {
        if (!agent || agent.status !== 'active') break;
        const f = this.newTask(agent, {
          instructions: `Follow up on this problem found during “${r.title}”:\n${issue.text}\n\nFind out more with your tools, explain the likely cause, and suggest exactly what a person should do next.`,
          title: `Follow up: ${issue.text}`,
          priority: 'high',
          source: 'followup',
          runAsId: t.runAsId,
          createdBy: t.runAsId,
          maxAttempts: 1,
        });
        f.parentTaskId = t.taskId;
        f.responsibilityId = r.responsibilityId;
        await this.d.repos.agentTasks.create(f);
        await this.enqueue(f).catch(() => undefined);
        issue.followUpTaskId = f.taskId;
      }
    }
    await this.d.repos.responsibilities.update(r.responsibilityId, {
      openIssues: open,
      resolvedIssues: [...solved, ...r.resolvedIssues].slice(0, 20),
      runs: r.runs + 1,
      lastRunAt: now,
      lastTaskId: t.taskId,
      updatedAt: now,
    });
    if (fresh.length) {
      await this.d.notifications.notify(await this.audience(t, 'always'), {
        kind: 'issue.new',
        title: `${t.agentName} found ${fresh.length === 1 ? 'a new problem' : `${fresh.length} new problems`}`,
        body: fresh.map((i) => i.text).join(' · '),
        link: `/ai-schedules?tab=responsibilities&r=${r.responsibilityId}`,
        agentId: t.agentId,
      });
    }
  }

  async run(taskId: string): Promise<void> {
    const t = await this.d.repos.agentTasks.get(taskId);
    if (!t || t.status !== 'queued') return; // cancelled meanwhile, or a duplicate job
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(new Error('timeout')), this.d.timeoutMs);
    this.running.set(taskId, ctrl);
    const startedAt = t.startedAt ?? nowIso(); // keeps the first start when continuing after an approval
    await this.d.repos.agentTasks.update(taskId, { status: 'running', startedAt, resume: null });
    t.startedAt = startedAt;
    const resume = t.resume ?? null;
    const transcript: TranscriptEntry[] | undefined = t.transcriptJson ? JSON.parse(t.transcriptJson) : undefined;

    const steps: AgentTask['steps'] = [...(t.steps ?? [])]; // keeps the note of an earlier automatic attempt
    const byKey = new Map<string, AgentTask['steps'][number]>();
    let tokens = { inputTokens: 0, outputTokens: 0 };
    let saving = Promise.resolve();
    const save = () => {
      saving = saving.then(() => this.d.repos.agentTasks.update(taskId, { steps: [...steps], ...tokens })).catch(() => undefined);
      return saving;
    };

    try {
      const user = await this.d.repos.users.get(t.runAsId);
      if (!user || user.status !== 'active') throw new Error('The person this task runs for no longer has an active account, so it can’t act for them.');
      const res = await this.d.assistant.runHeadless(user, {
        goal: `${t.instructions}\n\n(Background task “${t.title}”${t.source === 'schedule' ? ', started by its schedule' : ''}. Give a complete, well-formatted result: it is read later in the Task Center.)${t.responsibilityId && t.source === 'schedule' ? `\n\n${ISSUES_INSTRUCTION}` : ''}`,
        agentId: t.agentId,
        usePms: true,
        useWorkflows: true,
        websites: 'all',
        allowActions: false,
        signal: ctrl.signal,
        sessionId: `task-${taskId}`,
        taskId,
        toolLimit: t.source === 'delegation' ? t.toolLimit ?? null : null,
        transcript: resume ? transcript : undefined,
        resume: resume ? { tool: resume.tool, input: resume.input, approved: resume.approved } : undefined,
        gate: this.d.approvals.gateFor({ taskId, inChat: false }),
        onToolDone: (tool, input, ok) => (ok ? this.d.approvals.markUsedIfGranted({ taskId }, tool, input) : undefined),
        onStep: async (e) => {
          if (e.label === 'Thinking…') return;
          let st = byKey.get(e.stepKey);
          if (!st) {
            st = { label: e.label, status: 'running', at: nowIso() };
            byKey.set(e.stepKey, st);
            steps.push(st);
          }
          st.status = e.kind === 'done' ? 'done' : e.kind === 'error' ? 'error' : 'running';
          if (e.detail) st.detail = e.detail.slice(0, 300);
          await save();
        },
        onUsage: (u) => {
          tokens = { inputTokens: tokens.inputTokens + u.inputTokens, outputTokens: tokens.outputTokens + u.outputTokens };
        },
      });
      await saving;
      if (ctrl.signal.aborted) throw ctrl.signal.reason ?? new Error('cancelled');
      if (res.pending) {
        // It needs a person's OK: park the task and ask in the Approval Center.
        const agent = (await this.d.repos.agents.get(t.agentId))!;
        const ap = await this.d.approvals.create({
          source: 'task',
          taskId,
          agent,
          requestedFor: t.runAsId,
          title: t.title,
          tool: res.pending.tool,
          toolLabel: res.pending.label,
          input: res.pending.input,
          details: res.pending.details,
          target: res.pending.target,
          level: res.pending.level,
          reason: res.pending.say,
        });
        steps.push({ label: `Waiting for approval: ${res.pending.label}`, status: 'running', at: nowIso() });
        await this.d.repos.agentTasks.update(taskId, { status: 'waiting_approval', approvalId: ap.approvalId, transcriptJson: packTranscript(res.transcript.slice(-80)), steps, ...tokens });
        return;
      }
      const { text, issues } = t.responsibilityId && t.source === 'schedule' ? extractIssues(res.answer) : { text: res.answer, issues: [] };
      // The "waiting" line is done now.
      for (const st of steps) if (st.status === 'running' && st.label.startsWith('Waiting for approval')) st.status = 'done';
      await this.finish(t, 'completed', { transcriptJson: null, approvalId: null, output: text.slice(0, MAX_OUTPUT), issues, files: res.files.map((f) => ({ fileId: f.fileId, name: f.name, size: f.size })), steps, ...tokens });
    } catch (err) {
      await saving;
      const reason = ctrl.signal.aborted ? errMsg(ctrl.signal.reason) : '';
      if (reason === 'cancelled') await this.finish(t, 'cancelled', { error: 'Stopped by a person', steps, ...tokens });
      else if (reason === 'timeout') await this.finish(t, 'failed', { error: `Took longer than ${Math.round(this.d.timeoutMs / 60000)} minutes and was stopped.`, steps, ...tokens });
      else if ((err as any)?.retryable && t.attempt < t.maxAttempts) {
        // A busy or unreachable AI service: try once more after a short wait.
        await this.d.repos.agentTasks.update(taskId, { status: 'queued', attempt: t.attempt + 1, steps: [...steps, { label: `Attempt ${t.attempt} failed: ${errMsg(err)} — trying again`, status: 'error', at: nowIso() }] });
        setTimeout(() => void this.d.queue.add(taskId).catch(() => undefined), this.d.retryDelayMs ?? 30_000).unref?.();
      } else await this.finish(t, 'failed', { error: errMsg(err), steps, ...tokens });
    } finally {
      clearTimeout(timeout);
      this.running.delete(taskId);
    }
  }

  /** Waits until a task is no longer queued/running (tests). */
  async idle(taskId: string, ms = 10_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t = await this.d.repos.agentTasks.get(taskId);
      if (t && !['queued', 'running'].includes(t.status)) return t;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('task did not finish');
  }

  /* ------------------------------------------------------------- schedules */

  private ruleOf(rule: AgentScheduleRule) {
    const parsed = scheduleTriggerSchema.safeParse(rule);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Check the schedule');
    return parsed.data as AgentScheduleRule;
  }

  private versionFor(s: AgentSchedule): WorkflowVersion | null {
    if (!s.enabled) return null;
    // The scheduler understands workflow schedule triggers; give it one.
    return { nodes: [{ id: 'run', type: 'trigger.schedule', name: s.name, position: { x: 0, y: 0 }, config: s.rule }], connections: [] } as unknown as WorkflowVersion;
  }

  async sync(s: AgentSchedule) {
    await this.d.scheduler.sync(`${AI_SCHEDULE_PREFIX}${s.scheduleId}`, this.versionFor(s));
  }

  async resyncAll() {
    const all = await this.d.repos.agentSchedules.list(1000);
    for (const s of all) await this.sync(s).catch((e) => console.error('[ai-schedules]', errMsg(e)));
    return all.filter((s) => s.enabled).length;
  }

  private async view(user: AppUser, s: AgentSchedule, agents: Map<string, AiAgent>): Promise<AgentScheduleView> {
    const a = agents.get(s.agentId);
    let next: number | null = null;
    try {
      next = s.enabled ? nextRun(this.ruleOf(s.rule) as any, Date.now()) : null;
    } catch {
      next = null;
    }
    return {
      ...s,
      agentName: a?.name ?? 'Deleted AI employee',
      agentAvatar: a?.avatar ?? '🤖',
      agentColor: a?.color ?? 'slate',
      describe: describeSchedule(s.rule),
      nextRunAt: next ? new Date(next).toISOString() : null,
      canEdit: !!a && this.reg.canEdit(user, a),
    };
  }

  /** Schedules of the AI employees this person looks after (Admins: all). */
  async listSchedules(user: AppUser, agentId?: string) {
    const agents = new Map((await this.reg.listAll()).map((a) => [a.agentId, a]));
    const out: AgentScheduleView[] = [];
    for (const s of await this.d.repos.agentSchedules.list(1000)) {
      if (agentId && s.agentId !== agentId) continue;
      const a = agents.get(s.agentId);
      const visible = this.reg.canManage(user) || (a && this.reg.canEdit(user, a)) || s.createdBy === user.uid;
      if (visible) out.push(await this.view(user, s, agents));
    }
    return out;
  }

  private async editable(user: AppUser, agentId: string) {
    const a = await this.reg.getFor(user, agentId);
    if (!this.reg.canEdit(user, a)) throw forbidden('Only Admins and this AI employee’s managers can give it a schedule');
    return a;
  }

  async createSchedule(user: AppUser, input: ScheduleInput) {
    const a = await this.editable(user, input.agentId);
    const now = nowIso();
    const s: AgentSchedule = {
      scheduleId: newId('asch'),
      name: input.name.trim().slice(0, 80) || 'Daily task',
      agentId: a.agentId,
      instructions: input.instructions.trim().slice(0, 4000),
      rule: this.ruleOf(input.rule),
      startDate: input.startDate || null,
      endDate: input.endDate || null,
      priority: input.priority,
      enabled: input.enabled,
      notify: input.notify ?? 'failures',
      runAsId: user.uid,
      createdBy: user.uid,
      department: a.department,
      lastRunAt: null,
      lastTaskId: null,
      lastStatus: null,
      createdAt: now,
      updatedAt: now,
    };
    if (!s.instructions) throw badRequest('Write what it should do each time');
    await this.d.repos.agentSchedules.create(s);
    await this.sync(s);
    return this.view(user, s, new Map([[a.agentId, a]]));
  }

  private async ownSchedule(user: AppUser, id: string) {
    const s = await this.d.repos.agentSchedules.get(id);
    if (!s) throw notFound('Schedule not found');
    const a = await this.d.repos.agents.get(s.agentId);
    if (!this.reg.canManage(user) && !(a && this.reg.canEdit(user, a))) throw notFound('Schedule not found');
    return s;
  }

  async updateSchedule(user: AppUser, id: string, input: ScheduleInput) {
    const s = await this.ownSchedule(user, id);
    const a = await this.editable(user, input.agentId);
    const patch: Partial<AgentSchedule> = {
      name: input.name.trim().slice(0, 80) || s.name,
      agentId: a.agentId,
      department: a.department,
      instructions: input.instructions.trim().slice(0, 4000),
      rule: this.ruleOf(input.rule),
      startDate: input.startDate || null,
      endDate: input.endDate || null,
      priority: input.priority,
      enabled: input.enabled,
      notify: input.notify ?? s.notify ?? 'failures',
      // Whoever changes it last takes responsibility: it runs with their permissions.
      runAsId: user.uid,
      updatedAt: nowIso(),
    };
    if (!patch.instructions) throw badRequest('Write what it should do each time');
    await this.d.repos.agentSchedules.update(id, patch);
    const next = { ...s, ...patch } as AgentSchedule;
    await this.sync(next);
    return this.view(user, next, new Map([[a.agentId, a]]));
  }

  async deleteSchedule(user: AppUser, id: string) {
    const s = await this.ownSchedule(user, id);
    await this.d.repos.agentSchedules.delete(id);
    await this.sync({ ...s, enabled: false });
    return s;
  }

  /** "Run now": one task from this schedule straight away. */
  async runNow(user: AppUser, id: string) {
    const s = await this.ownSchedule(user, id);
    return this.fire(s.scheduleId, nowIso(), `now:${crypto.randomUUID()}`, true);
  }

  /** Called by the scheduler (any process). Creates at most one task per occurrence. */
  async fire(scheduleId: string, scheduledFor: string, occurrenceKey: string, manual = false): Promise<AgentTask | null> {
    const s = await this.d.repos.agentSchedules.get(scheduleId);
    if (!s || (!s.enabled && !manual)) return null;
    const day = scheduledFor.slice(0, 10);
    if (!manual && s.startDate && day < s.startDate) return null;
    if (!manual && s.endDate && day > s.endDate) {
      await this.d.repos.agentSchedules.update(scheduleId, { enabled: false, updatedAt: nowIso() });
      await this.sync({ ...s, enabled: false });
      return null;
    }
    const resp = s.responsibilityId ? await this.d.repos.responsibilities.get(s.responsibilityId) : null;
    if (resp?.status === 'paused' && !manual) return null; // the responsibility is paused, so its schedules wait
    const agent = await this.d.repos.agents.get(s.agentId);
    const taskId = `task_${crypto.createHash('sha256').update(`${scheduleId}|${occurrenceKey}`).digest('hex').slice(0, 24)}`;
    if (!agent || agent.status !== 'active') {
      const t = this.newTask(agent ?? ({ agentId: s.agentId, name: 'Deleted AI employee', department: s.department } as AiAgent), {
        taskId, instructions: s.instructions, title: s.name, priority: s.priority, source: 'schedule', scheduleId, occurrenceKey, runAsId: s.runAsId, createdBy: s.createdBy, maxAttempts: 1,
      });
      t.status = 'failed';
      t.error = 'The AI employee is switched off or deleted, so the schedule could not run.';
      t.completedAt = nowIso();
      try {
        await this.d.repos.agentTasks.create(t);
      } catch {
        return null;
      }
      await this.d.repos.agentSchedules.update(scheduleId, { lastRunAt: scheduledFor, lastTaskId: taskId, lastStatus: 'failed' });
      await this.tell(t).catch(() => undefined);
      return t;
    }
    const t = this.newTask(agent, { taskId, instructions: s.instructions, title: s.name, priority: s.priority, source: 'schedule', scheduleId, occurrenceKey, runAsId: s.runAsId, createdBy: s.createdBy, maxAttempts: 2 });
    t.responsibilityId = resp?.responsibilityId ?? null;
    try {
      await this.d.repos.agentTasks.create(t);
    } catch {
      return null; // this occurrence already made its task (another worker, or a repeated job)
    }
    await this.d.repos.agentSchedules.update(scheduleId, { lastRunAt: scheduledFor, lastTaskId: taskId, lastStatus: 'queued' });
    await this.enqueue(t);
    return t;
  }
  /* ----------------------------------------------------------- collaboration */

  /** Team projects this person may see: their own, all for Admins, and those of managers they look after. */
  async listProjects(user: AppUser): Promise<import('@widebed/shared').AgentProjectView[]> {
    const agents = new Map((await this.reg.listAll()).map((a) => [a.agentId, a]));
    const users = new Map((await this.d.repos.users.list(1000)).map((u) => [u.uid, u.name]));
    const out: import('@widebed/shared').AgentProjectView[] = [];
    for (const p of await this.d.repos.projects.listRecent(200)) {
      const m = agents.get(p.managerAgentId);
      const visible = this.reg.canManage(user) || p.requestedFor === user.uid || (!!m && this.reg.canEdit(user, m));
      if (!visible) continue;
      const subs = await Promise.all(p.subtaskIds.map((id) => this.d.repos.agentTasks.get(id)));
      out.push({
        ...p,
        managerAvatar: m?.avatar ?? '🧭',
        managerColor: m?.color ?? 'slate',
        requestedForName: users.get(p.requestedFor) ?? 'Someone',
        subtasks: subs
          .filter((t): t is AgentTask => !!t)
          .map((t) => ({ taskId: t.taskId, agentId: t.agentId, agentName: t.agentName, title: t.title, instructions: t.instructions, status: t.status, output: t.output, error: t.error, dependsOn: t.dependsOn ?? [], startedAt: t.startedAt, completedAt: t.completedAt, durationMs: t.durationMs, approvalId: t.approvalId ?? null })),
      });
      if (out.length >= 100) break;
    }
    return out;
  }

  /* -------------------------------------------------------- responsibilities */

  async listResponsibilities(user: AppUser): Promise<AgentResponsibilityView[]> {
    const agents = new Map((await this.reg.listAll()).map((a) => [a.agentId, a]));
    const schedules = await this.d.repos.agentSchedules.list(1000);
    const out: AgentResponsibilityView[] = [];
    for (const r of await this.d.repos.responsibilities.list(500)) {
      const a = agents.get(r.agentId);
      const canEdit = !!a && this.reg.canEdit(user, a);
      const visible = this.reg.canManage(user) || canEdit || (hasPermission(user, 'execution.viewDepartment') && !!user.department && r.department === user.department);
      if (!visible) continue;
      out.push({
        ...r,
        agentName: a?.name ?? 'Deleted AI employee',
        agentAvatar: a?.avatar ?? '🤖',
        agentColor: a?.color ?? 'slate',
        schedules: schedules.filter((x) => x.responsibilityId === r.responsibilityId).map((x) => ({ scheduleId: x.scheduleId, name: x.name, describe: describeSchedule(x.rule), enabled: x.enabled })),
        canEdit,
      });
    }
    return out;
  }

  private async checkSchedules(agentId: string, scheduleIds: string[]) {
    for (const id of scheduleIds) {
      const s = await this.d.repos.agentSchedules.get(id);
      if (!s || s.agentId !== agentId) throw badRequest('A responsibility can only use schedules of the same AI employee');
    }
  }

  private async linkSchedules(_user: AppUser, r: AgentResponsibility, scheduleIds: string[]) {
    for (const s of await this.d.repos.agentSchedules.list(1000)) {
      const want = scheduleIds.includes(s.scheduleId);
      if (want && s.responsibilityId !== r.responsibilityId) await this.d.repos.agentSchedules.update(s.scheduleId, { responsibilityId: r.responsibilityId, updatedAt: nowIso() });
      if (!want && s.responsibilityId === r.responsibilityId) await this.d.repos.agentSchedules.update(s.scheduleId, { responsibilityId: null, updatedAt: nowIso() });
    }
  }

  async createResponsibility(user: AppUser, input: ResponsibilityInput) {
    const a = await this.editable(user, input.agentId);
    const now = nowIso();
    const r: AgentResponsibility = {
      responsibilityId: newId('resp'),
      agentId: a.agentId,
      title: input.title.trim().slice(0, 120),
      description: input.description.trim().slice(0, 2000),
      status: input.status,
      autoFollowUp: input.autoFollowUp,
      openIssues: [],
      resolvedIssues: [],
      runs: 0,
      lastRunAt: null,
      lastTaskId: null,
      createdBy: user.uid,
      department: a.department,
      createdAt: now,
      updatedAt: now,
    };
    if (!r.title) throw badRequest('Give the responsibility a title');
    await this.checkSchedules(a.agentId, input.scheduleIds);
    await this.d.repos.responsibilities.create(r);
    await this.linkSchedules(user, r, input.scheduleIds);
    return r;
  }

  private async ownResponsibility(user: AppUser, id: string) {
    const r = await this.d.repos.responsibilities.get(id);
    const a = r ? await this.d.repos.agents.get(r.agentId) : null;
    if (!r || !(this.reg.canManage(user) || (a && this.reg.canEdit(user, a)))) throw notFound('Responsibility not found');
    return r;
  }

  async updateResponsibility(user: AppUser, id: string, input: ResponsibilityInput) {
    const r = await this.ownResponsibility(user, id);
    if (input.agentId !== r.agentId) throw badRequest('A responsibility stays with its AI employee. Make a new one for someone else.');
    await this.checkSchedules(r.agentId, input.scheduleIds);
    const patch: Partial<AgentResponsibility> = {
      title: input.title.trim().slice(0, 120) || r.title,
      description: input.description.trim().slice(0, 2000),
      status: input.status,
      autoFollowUp: input.autoFollowUp,
      updatedAt: nowIso(),
    };
    await this.d.repos.responsibilities.update(id, patch);
    await this.linkSchedules(user, { ...r, ...patch } as AgentResponsibility, input.scheduleIds);
    return { ...r, ...patch } as AgentResponsibility;
  }

  async deleteResponsibility(user: AppUser, id: string) {
    const r = await this.ownResponsibility(user, id);
    await this.linkSchedules(user, r, []);
    await this.d.repos.responsibilities.delete(id);
    return r;
  }

  /** A person says a problem is sorted. If a later run reports it again, it comes back as new. */
  async resolveIssue(user: AppUser, id: string, key: string) {
    const r = await this.ownResponsibility(user, id);
    const issue = r.openIssues.find((i) => i.key === key);
    if (!issue) throw notFound('That problem is not open');
    await this.d.repos.responsibilities.update(id, {
      openIssues: r.openIssues.filter((i) => i.key !== key),
      resolvedIssues: [{ ...issue, resolvedAt: nowIso() }, ...r.resolvedIssues].slice(0, 20),
      updatedAt: nowIso(),
    });
  }
}

export interface ScheduleInput {
  name: string;
  agentId: string;
  instructions: string;
  rule: AgentScheduleRule;
  startDate: string | null;
  endDate: string | null;
  priority: AgentTaskPriority;
  enabled: boolean;
  notify?: 'failures' | 'always' | 'off';
}

export interface ResponsibilityInput {
  agentId: string;
  title: string;
  description: string;
  status: 'active' | 'paused';
  autoFollowUp: boolean;
  /** Schedules (of the same AI employee) that carry it out. */
  scheduleIds: string[];
}
