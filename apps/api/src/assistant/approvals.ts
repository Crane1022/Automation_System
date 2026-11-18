import crypto from 'node:crypto';
import {
  CRITICAL_CONFIRM_WORD,
  DEFAULT_SYSTEM_SETTINGS,
  canonicalJson,
  hasPermission,
  type AgentApproval,
  type AgentApprovalView,
  type AiAgent,
  type AppUser,
  type LowRiskPolicy,
  type RiskLevel,
  type SystemSettings,
} from '@widebed/shared';
import type { Repositories } from '../repositories/types.js';
import type { NotificationService } from '../services/notifications.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http-error.js';
import { newId, nowIso } from '../lib/ids.js';
import type { AgentRegistry } from './agents.js';
import type { ToolGate } from './agent.js';

export const hashAction = (tool: string, input: unknown) => crypto.createHash('sha256').update(`${tool}\n${canonicalJson(input)}`).digest('hex');

/** What happens after a decision: the chat or task carries on (with approved = false it is told “no”). */
export type DecisionHandler = (a: AgentApproval, approved: boolean) => Promise<void>;

export interface NewApproval {
  source: 'chat' | 'task';
  chatId?: string | null;
  taskId?: string | null;
  agent: AiAgent;
  requestedFor: string;
  title: string;
  tool: string;
  toolLabel: string;
  input: unknown;
  details: string;
  target: string;
  level: RiskLevel;
  reason: string;
}

/**
 * Approval Center rules (all checked here, on the server):
 * - An approval covers ONE exact action: tool + parameters (sha256). Different parameters = new approval.
 * - Single use: pending → approved/rejected happens once (atomic); the action can run once (usedAt).
 * - It expires (default 24 h; critical ones 2 h). Expired requests are never run.
 * - Who may decide: the person it runs for (up to level 3), the AI employee's named approvers and
 *   Admins (any level). Critical (level 4) also needs the word APPROVE typed.
 * - Editing makes a NEW request (the old one is “replaced”) that someone must confirm.
 * - AI employees can't decide anything: decisions only come from signed-in people.
 * - Permissions are checked again when the chat/task carries on and the tool runs.
 */
export class ApprovalService {
  private handlers: Partial<Record<'chat' | 'task', DecisionHandler>> = {};

  constructor(
    private d: {
      repos: Repositories;
      agents: AgentRegistry;
      notifications: NotificationService;
      settings: () => Promise<SystemSettings>;
    },
  ) {}

  onDecision(source: 'chat' | 'task', fn: DecisionHandler) {
    this.handlers[source] = fn;
  }

  private async policy() {
    return { ...DEFAULT_SYSTEM_SETTINGS.ai, ...((await this.d.settings()).ai ?? {}) };
  }

  /* ------------------------------------------------------------ the gate */

  /**
   * The gate used while an AI employee works: level 2 follows the Admin policy, level 3–4
   * need an approved, unused approval for exactly this action (same chat/task), otherwise “ask”.
   */
  gateFor(where: { chatId?: string; taskId?: string; inChat: boolean; allowAll?: boolean }): ToolGate {
    return async ({ tool, input, level }) => {
      if (where.allowAll) return 'run';
      if (level <= 1) return 'run';
      if (level === 2) {
        const p: LowRiskPolicy = (await this.policy()).lowRiskPolicy;
        if (p === 'auto' || (p === 'auto_in_chat' && where.inChat)) return 'run';
      }
      return (await this.grant(where, tool, input)) ? 'run' : 'ask';
    };
  }

  /** An approved, unused, unexpired approval for exactly this action here. */
  async grant(where: { chatId?: string; taskId?: string }, tool: string, input: unknown) {
    const hash = hashAction(tool, input);
    const now = nowIso();
    const list = await this.d.repos.approvals.listByStatus('approved', 500);
    return (
      list.find(
        (a) =>
          !a.usedAt &&
          a.inputHash === hash &&
          a.tool === tool &&
          a.expiresAt > now &&
          ((where.taskId && a.taskId === where.taskId) || (where.chatId && a.chatId === where.chatId)),
      ) ?? null
    );
  }

  /** After the tool ran successfully: the approval is used up. */
  async markUsedIfGranted(where: { chatId?: string; taskId?: string }, tool: string, input: unknown) {
    const g = await this.grant(where, tool, input);
    if (g) await this.d.repos.approvals.markUsed(g.approvalId, nowIso());
  }

  /* ----------------------------------------------------------- requests */

  async create(n: NewApproval): Promise<AgentApproval> {
    const p = await this.policy();
    const hours = n.level >= 4 ? Math.min(2, p.approvalHours) : p.approvalHours;
    const now = Date.now();
    const a: AgentApproval = {
      approvalId: newId('appr'),
      source: n.source,
      chatId: n.chatId ?? null,
      taskId: n.taskId ?? null,
      agentId: n.agent.agentId,
      agentName: n.agent.name,
      agentAvatar: n.agent.avatar,
      agentColor: n.agent.color,
      department: n.agent.department,
      requestedFor: n.requestedFor,
      title: n.title.slice(0, 120),
      tool: n.tool,
      toolLabel: n.toolLabel.slice(0, 200),
      input: n.input ?? {},
      inputHash: hashAction(n.tool, n.input ?? {}),
      details: n.details.slice(0, 1000),
      target: n.target,
      level: n.level,
      reason: n.reason.slice(0, 500),
      status: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + hours * 3600_000).toISOString(),
      decidedBy: null,
      decidedAt: null,
      note: null,
      editedFrom: null,
      editedBy: null,
      usedAt: null,
    };
    await this.d.repos.approvals.create(a);
    await this.announce(a);
    return a;
  }

  /** Tell the people who can decide (in a chat, the person is right there unless it's critical). */
  private async announce(a: AgentApproval) {
    const agent = await this.d.repos.agents.get(a.agentId);
    const admins = a.level >= 4 ? (await this.d.repos.users.list(1000)).filter((u) => u.status === 'active' && hasPermission(u as AppUser, 'agent.manage')).map((u) => u.uid) : [];
    const who = [...(a.source === 'task' ? [a.requestedFor] : []), ...(agent?.approverIds ?? []), ...admins].filter((uid) => !(a.source === 'chat' && uid === a.requestedFor));
    await this.d.notifications.notify(who, {
      kind: 'approval.needed',
      title: `${a.agentName} needs approval${a.level >= 4 ? ' (critical)' : ''}`,
      body: a.toolLabel,
      link: `/ai-approvals?id=${a.approvalId}`,
      agentId: a.agentId,
    });
  }

  /** Withdraw a request nobody answered (e.g. the person sent another message instead). */
  async withdraw(id: string, note: string) {
    await this.d.repos.approvals.transition(id, 'pending', { status: 'rejected', decidedAt: nowIso(), note });
  }

  /* ------------------------------------------------------------ deciding */

  private whyNot(user: AppUser, a: AgentApproval, agent: AiAgent | null): string | null {
    if (a.status !== 'pending') return 'Already decided';
    if (a.expiresAt <= nowIso()) return 'Expired';
    if (this.d.agents.canManage(user)) return null;
    if (agent?.approverIds?.includes(user.uid)) return null;
    if (a.requestedFor === user.uid) return a.level >= 4 ? 'Critical actions need an Admin or a named approver' : null;
    return 'You are not an approver for this AI employee';
  }

  private async canSee(user: AppUser, a: AgentApproval, agent: AiAgent | null) {
    if (this.d.agents.canManage(user) || a.requestedFor === user.uid) return true;
    if (agent && (agent.approverIds?.includes(user.uid) || this.d.agents.canEdit(user, agent))) return true;
    return false;
  }

  /** Marks overdue requests as expired, and lets their chat/task know. */
  async sweep() {
    const now = nowIso();
    let n = 0;
    for (const a of await this.d.repos.approvals.listByStatus('pending', 500)) {
      if (a.expiresAt > now) continue;
      if (await this.d.repos.approvals.transition(a.approvalId, 'pending', { status: 'expired', decidedAt: now, note: 'Nobody decided in time' })) {
        n++;
        await this.handlers[a.source]?.({ ...a, status: 'expired' }, false).catch((e) => console.error('[approvals] expiry', e?.message));
      }
    }
    return n;
  }

  async list(user: AppUser, status?: 'pending' | 'history'): Promise<AgentApprovalView[]> {
    await this.sweep();
    const agents = new Map((await this.d.agents.listAll()).map((a) => [a.agentId, a]));
    const users = new Map((await this.d.repos.users.list(1000)).map((u) => [u.uid, u.name]));
    const out: AgentApprovalView[] = [];
    for (const a of await this.d.repos.approvals.listRecent(500)) {
      if (status === 'pending' && a.status !== 'pending') continue;
      if (status === 'history' && a.status === 'pending') continue;
      const agent = agents.get(a.agentId) ?? null;
      if (!(await this.canSee(user, a, agent))) continue;
      const whyNot = this.whyNot(user, a, agent);
      out.push({ ...a, requestedForName: users.get(a.requestedFor) ?? 'Someone', decidedByName: a.decidedBy ? users.get(a.decidedBy) ?? 'Someone' : null, canDecide: !whyNot, whyNot });
      if (out.length >= 200) break;
    }
    return out;
  }

  async get(user: AppUser, id: string) {
    const a = await this.d.repos.approvals.get(id);
    const agent = a ? await this.d.repos.agents.get(a.agentId) : null;
    if (!a || !(await this.canSee(user, a, agent))) throw notFound('Approval not found');
    return { a, agent };
  }

  /** Approve or reject exactly this request. */
  async decide(user: AppUser, id: string, d: { approve: boolean; note?: string; confirmWord?: string }) {
    await this.sweep();
    const { a, agent } = await this.get(user, id);
    const why = this.whyNot(user, a, agent);
    if (why === 'Already decided' || why === 'Expired') throw conflict(why === 'Expired' ? 'This request has expired, so it can’t be approved. Nothing was done.' : 'Someone already decided this request');
    // The person it runs for may always say no to their own request, even a critical one.
    const ownNo = !d.approve && a.requestedFor === user.uid;
    if (why && !ownNo) throw forbidden(why);
    if (d.approve && a.level >= 4 && (d.confirmWord ?? '').trim().toUpperCase() !== CRITICAL_CONFIRM_WORD) {
      throw badRequest(`This is a critical action. Type ${CRITICAL_CONFIRM_WORD} to confirm.`);
    }
    const won = await this.d.repos.approvals.transition(id, 'pending', {
      status: d.approve ? 'approved' : 'rejected',
      decidedBy: user.uid,
      decidedAt: nowIso(),
      note: d.note?.trim().slice(0, 500) || null,
    });
    if (!won) throw conflict('Someone already decided this request');
    const decided = (await this.d.repos.approvals.get(id))!;
    if (decided.requestedFor !== user.uid) {
      await this.d.notifications.notify([decided.requestedFor], {
        kind: 'approval.decided',
        title: `${d.approve ? 'Approved' : 'Not approved'}: ${decided.toolLabel}`,
        body: `${decided.agentName} · decided by ${user.name}${decided.note ? ` — “${decided.note}”` : ''}`,
        link: decided.source === 'task' && decided.taskId ? `/ai-tasks?task=${decided.taskId}` : `/ai-approvals?id=${id}`,
        agentId: decided.agentId,
      });
    }
    await this.handlers[decided.source]?.(decided, d.approve);
    return decided;
  }

  /**
   * Change the parameters, then send it back for confirmation: the old request becomes
   * “replaced” and a new pending one (edited) takes its place. Someone allowed must confirm it.
   */
  async edit(user: AppUser, id: string, input: unknown, note?: string) {
    const { a, agent } = await this.get(user, id);
    const why = this.whyNot(user, a, agent);
    if (why) throw why === 'Already decided' || why === 'Expired' ? conflict('Only waiting requests can be edited') : forbidden(why);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('The parameters must be an object (field: value)');
    if (hashAction(a.tool, input) === a.inputHash) throw badRequest('Nothing was changed');
    const next: AgentApproval = {
      ...a,
      approvalId: newId('appr'),
      input,
      inputHash: hashAction(a.tool, input),
      details: `${a.details}\n\nEdited by ${user.name}${note ? `: ${note}` : ''}. New parameters: ${JSON.stringify(input).slice(0, 400)}`,
      status: 'pending',
      createdAt: nowIso(),
      editedFrom: a.approvalId,
      editedBy: user.uid,
      note: note?.trim().slice(0, 500) || null,
      decidedBy: null,
      decidedAt: null,
      usedAt: null,
    };
    if (!(await this.d.repos.approvals.transition(id, 'pending', { status: 'replaced', decidedBy: user.uid, decidedAt: nowIso(), note: `Edited — see the new request` }))) {
      throw conflict('Someone already decided this request');
    }
    await this.d.repos.approvals.create(next);
    // The waiting chat/task now waits for the edited request.
    if (a.source === 'chat' && a.chatId) {
      const chat = await this.d.repos.assistant.getChat(a.chatId);
      if (chat?.pendingJson) {
        const p = JSON.parse(chat.pendingJson);
        await this.d.repos.assistant.updateChat(a.chatId, { pendingJson: JSON.stringify({ ...p, input, approvalId: next.approvalId }) });
      }
    } else if (a.taskId) await this.d.repos.agentTasks.update(a.taskId, { approvalId: next.approvalId });
    await this.announce(next);
    return next;
  }
}
