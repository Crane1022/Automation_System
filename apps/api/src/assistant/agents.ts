import {
  AGENT_TEMPLATES,
  DEFAULT_AGENT_ID,
  DELEGATED_AGENT_FIELDS,
  builtInAssistant,
  blankAgent,
  hasPermission,
  type AgentInput,
  type AiAgent,
  type AppUser,
} from '@widebed/shared';
import type { Repositories } from '../repositories/types.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http-error.js';
import { newId, nowIso } from '../lib/ids.js';

/**
 * AI Staff registry: who the AI employees are and who may use or change them.
 * All checks happen here, on the server; the web app only hides buttons.
 */
export class AgentRegistry {
  private seeded = false;

  constructor(private repos: Repositories) {}

  canManage(user: AppUser) {
    return hasPermission(user, 'agent.manage');
  }

  /** Admins, and people an Admin made a manager of this AI employee. */
  canEdit(user: AppUser, a: AiAgent) {
    return this.canManage(user) || (a.status !== 'archived' && (a.managerIds ?? []).includes(user.uid));
  }

  /** May this person see the agent in the list? (Admins see every agent, also disabled ones; its managers see it while switched off too.) */
  canSee(user: AppUser, a: AiAgent) {
    if (this.canManage(user)) return true;
    if (this.canEdit(user, a)) return true;
    if (a.status !== 'active') return false;
    if (a.allowedUserIds.includes(user.uid)) return true;
    if (a.allowedRoles.length && !a.allowedRoles.includes(user.role)) return false;
    if (a.visibility === 'company') return true;
    if (a.visibility === 'department') return !!a.department && a.department === user.department;
    return a.createdBy === user.uid;
  }

  /** May this person chat with it right now? */
  canChat(user: AppUser, a: AiAgent) {
    return a.status === 'active' && this.canSee(user, a);
  }

  /** Creates the built-in Widebed Assistant agent the first time (no data is moved). */
  async ensureBuiltIn() {
    if (this.seeded) return;
    if (!(await this.repos.agents.get(DEFAULT_AGENT_ID))) {
      const now = nowIso();
      try {
        await this.repos.agents.create({ ...builtInAssistant(), agentId: DEFAULT_AGENT_ID, builtIn: true, createdBy: null, createdAt: now, updatedAt: now, lastActiveAt: null });
      } catch {
        /* created at the same moment by another request */
      }
    }
    this.seeded = true;
  }

  async listAll() {
    await this.ensureBuiltIn();
    return (await this.repos.agents.list(500)).map(norm);
  }

  async listFor(user: AppUser) {
    return (await this.listAll()).filter((a) => this.canSee(user, a));
  }

  /** An agent this person may see (404 otherwise, so ids of hidden agents don't leak). */
  async getFor(user: AppUser, agentId: string) {
    await this.ensureBuiltIn();
    const raw = await this.repos.agents.get(agentId);
    const a = raw ? norm(raw) : null;
    if (!a || !this.canSee(user, a)) throw notFound('AI employee not found');
    return a;
  }

  async getForChat(user: AppUser, agentId: string) {
    const a = await this.getFor(user, agentId);
    if (a.status !== 'active') throw badRequest(`${a.name} is switched off. An admin can switch it on in AI Staff.`);
    return a;
  }

  private async checkInput(input: AgentInput) {
    if (input.aiCredentialId) {
      const c = await this.repos.credentials.get(input.aiCredentialId);
      if (!c || c.provider !== 'ai_provider') throw badRequest('Choose an AI service connection (Credentials → AI)');
    }
    if (input.tools.websites !== 'all') {
      for (const id of input.tools.websites) {
        const c = await this.repos.credentials.get(id);
        if (!c || c.provider !== 'website_login') throw badRequest('One of the chosen websites no longer exists');
      }
    }
    const ids = [...input.allowedUserIds, ...(input.managerIds ?? []), ...(input.approverIds ?? [])];
    if (ids.length) {
      const known = new Set((await this.repos.users.list(1000)).map((u) => u.uid));
      if (ids.some((id) => !known.has(id))) throw badRequest('One of the chosen people no longer exists');
    }
  }

  async create(user: AppUser, input: AgentInput) {
    if (!this.canManage(user)) throw forbidden('Only Admins can create AI employees');
    await this.checkInput(input);
    const now = nowIso();
    const agent: AiAgent = { ...blankAgent(), ...input, agentId: newId('agent'), builtIn: false, createdBy: user.uid, createdAt: now, updatedAt: now, lastActiveAt: null };
    await this.repos.agents.create(agent);
    return agent;
  }

  async createFromTemplate(user: AppUser, templateId: string) {
    const t = AGENT_TEMPLATES.find((x) => x.templateId === templateId);
    if (!t) throw notFound('Template not found');
    return this.create(user, { ...blankAgent(), ...t.agent, tools: { ...blankAgent().tools, ...(t.agent.tools ?? {}) }, templateId });
  }

  async update(user: AppUser, agentId: string, input: AgentInput) {
    const a = await this.getFor(user, agentId);
    if (!this.canEdit(user, a)) throw forbidden('Only Admins and this AI employee’s managers can change it');
    if (!this.canManage(user)) {
      // A delegated manager changes the job and behaviour only; AI, tools and access stay as the Admin set them.
      const patch: Partial<AiAgent> = { updatedAt: nowIso() };
      for (const k of DELEGATED_AGENT_FIELDS) (patch as any)[k] = input[k];
      await this.repos.agents.update(agentId, patch);
      return { ...a, ...patch } as AiAgent;
    }
    await this.checkInput(input);
    if (a.builtIn && input.status === 'archived') throw badRequest('The Widebed Assistant can be switched off, but not archived');
    const patch: Partial<AiAgent> = { ...input, updatedAt: nowIso() };
    await this.repos.agents.update(agentId, patch);
    return { ...a, ...patch } as AiAgent;
  }

  async duplicate(user: AppUser, agentId: string) {
    const a = await this.getFor(user, agentId);
    const { agentId: _id, builtIn: _b, createdBy: _c, createdAt: _ca, updatedAt: _u, lastActiveAt: _l, ...rest } = a;
    return this.create(user, { ...rest, name: `${a.name} (copy)`.slice(0, 80) });
  }

  async setStatus(user: AppUser, agentId: string, status: AiAgent['status']) {
    if (!this.canManage(user)) throw forbidden('Only Admins can change AI employees');
    const a = await this.getFor(user, agentId);
    if (a.builtIn && status === 'archived') throw badRequest('The Widebed Assistant can be switched off, but not archived');
    await this.repos.agents.update(agentId, { status, updatedAt: nowIso() });
    return { ...a, status };
  }

  /** Deleting is only for archived agents, so it is always a two-step decision. Chats stay with their owners. */
  async remove(user: AppUser, agentId: string) {
    if (!this.canManage(user)) throw forbidden('Only Admins can delete AI employees');
    const a = await this.getFor(user, agentId);
    if (a.builtIn) throw badRequest('The Widebed Assistant can’t be deleted');
    if (a.status !== 'archived') throw conflict('Archive this AI employee first, then delete it');
    await this.repos.agents.delete(agentId);
    return a;
  }

  /** Who may chat with this AI employee right now, and why (for the Access section). */
  async accessList(user: AppUser, agentId: string) {
    const a = await this.getFor(user, agentId);
    if (!this.canEdit(user, a)) throw forbidden();
    const people = (await this.repos.users.list(1000)).filter((u) => u.status === 'active');
    return people
      .map((u) => {
        const can = this.canChat(u as AppUser, a);
        const why = !can
          ? null
          : this.canManage(u as AppUser)
            ? 'Admin'
            : a.managerIds.includes(u.uid)
              ? 'Manager of this AI employee'
              : a.allowedUserIds.includes(u.uid)
                ? 'Added by name'
                : a.visibility === 'company'
                  ? 'Everyone'
                  : a.visibility === 'department'
                    ? `${u.department} department`
                    : 'Creator';
        return { uid: u.uid, name: u.name, email: u.email, department: u.department, role: u.role, canChat: can, why };
      })
      .filter((p) => p.canChat)
      .sort((x, y) => x.name.localeCompare(y.name));
  }

  async touch(agentId: string) {
    await this.repos.agents.update(agentId, { lastActiveAt: nowIso() }).catch(() => undefined);
  }
}

/** Fills in fields added after an agent was saved (e.g. managerIds in Phase 3). */
function norm(a: AiAgent): AiAgent {
  return { ...a, canDelegate: a.canDelegate ?? false, managerIds: a.managerIds ?? [], approverIds: a.approverIds ?? [], allowedUserIds: a.allowedUserIds ?? [], allowedRoles: a.allowedRoles ?? [] };
}

/** The text that tells the AI who it is. */
export function identityText(a: AiAgent): string {
  const lines = [
    `You are ${a.name}${a.title ? `, ${a.title}` : ''}${a.department ? ` in the ${a.department} department` : ''} — an AI employee of Widebed, a short-term rental management company in Malaysia.`,
  ];
  if (a.description) lines.push(`What you do: ${a.description}`);
  if (a.responsibilities.length) lines.push(`Your responsibilities:\n${a.responsibilities.map((r) => `- ${r}`).join('\n')}`);
  if (a.expertise.length) lines.push(`Your expertise: ${a.expertise.join(', ')}.`);
  if (a.personality) lines.push(`Personality: ${a.personality}`);
  if (a.communicationStyle) lines.push(`How you write: ${a.communicationStyle}`);
  if (a.instructions) lines.push(`Instructions from your manager (follow them, but never break the RULES below):\n${a.instructions}`);
  lines.push('If a request is clearly outside your job, still help if you can with your tools, or say which colleague would be better.');
  return lines.join('\n');
}
