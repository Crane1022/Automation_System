import type { Credential, Execution, ExecutionStep, Workflow, WorkflowVersion } from '@widebed/shared';
import type {
  AuditLog,
  ExecutionFilter,
  Repositories,
  StoredExecution,
  WebhookEndpoint,
} from './types.js';

/** In-memory repositories for tests and local experiments. Not for production. */
export function createMemoryRepositories(): Repositories {
  const users = new Map<string, any>();
  const workflows = new Map<string, Workflow>();
  const versions = new Map<string, WorkflowVersion>();
  const executions = new Map<string, StoredExecution>();
  const steps = new Map<string, Map<string, ExecutionStep>>();
  const folders = new Map<string, any>();
  const templates = new Map<string, any>();
  const chats = new Map<string, any>();
  const chatMessages = new Map<string, Map<string, any>>();
  const memories = new Map<string, any>();
  const agents = new Map<string, any>();
  const agentTasks = new Map<string, any>();
  const agentSchedules = new Map<string, any>();
  const responsibilities = new Map<string, any>();
  const notifications = new Map<string, any>();
  const approvals = new Map<string, any>();
  const projects = new Map<string, any>();
  const kDocs = new Map<string, any>();
  const usage = new Map<string, any>();
  const chatImages = new Map<string, Map<string, any>>();
  const kChunks = new Map<string, any[]>();
  const settings = new Map<string, unknown>();
  const chatMemory = new Map<string, any>();
  const webhooks = new Map<string, WebhookEndpoint>();
  const audit: AuditLog[] = [];
  const creds = new Map<string, Credential>();
  const secrets = new Map<string, string>();

  const clone = <T>(v: T): T => structuredClone(v);
  const byNewest = <T extends { updatedAt?: string; createdAt?: string }>(a: T, b: T) =>
    (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '');

  const matches = (e: Execution, f: ExecutionFilter) =>
    (!f.workflowId || e.workflowId === f.workflowId) &&
    (!f.status || e.status === f.status) &&
    (!f.triggerType || e.triggerType === f.triggerType) &&
    (!f.department || e.department === f.department) &&
    (!f.initiatedBy || e.initiatedBy === f.initiatedBy) &&
    (!f.from || e.createdAt >= f.from) &&
    (!f.to || e.createdAt <= f.to);

  return {
    async ping() {},
    users: {
      async get(uid) { return users.has(uid) ? clone(users.get(uid)) : null; },
      async create(u) {
        if (users.has(u.uid)) throw new Error('ALREADY_EXISTS');
        users.set(u.uid, clone(u));
      },
      async update(uid, p) { users.set(uid, { ...users.get(uid), ...clone(p) }); },
      async list(limit) { return [...users.values()].slice(0, limit).map(clone); },
    },
    workflows: {
      async get(id) { return workflows.has(id) ? clone(workflows.get(id)!) : null; },
      async create(wf) { workflows.set(wf.workflowId, clone(wf)); },
      async update(id, p) { workflows.set(id, { ...workflows.get(id)!, ...clone(p) }); },
      async delete(id) { workflows.delete(id); },
      async listAll(limit) { return [...workflows.values()].sort(byNewest).slice(0, limit).map(clone); },
      async listByDepartment(d, limit) { return [...workflows.values()].filter((w) => w.department === d).sort(byNewest).slice(0, limit).map(clone); },
      async listByOwner(uid, limit) { return [...workflows.values()].filter((w) => w.ownerId === uid).sort(byNewest).slice(0, limit).map(clone); },
      async listSharedWith(uid, limit) { return [...workflows.values()].filter((w) => w.sharedWith.includes(uid)).sort(byNewest).slice(0, limit).map(clone); },
      async count(f) { return [...workflows.values()].filter((w) => !f.status || w.status === f.status).length; },
      async listActiveByEvent(name, limit) {
        return [...workflows.values()].filter((w) => w.status === 'active' && (w.eventTriggers ?? []).includes(name)).slice(0, limit).map(clone);
      },
      async listActive(limit) { return [...workflows.values()].filter((w) => w.status === 'active').slice(0, limit).map(clone); },
      async publish(workflowId, build) {
        const wf = workflows.get(workflowId);
        if (!wf) throw new Error('Workflow not found');
        const v = build((wf.publishedVersion ?? 0) + 1, clone(wf));
        if (versions.has(v.versionId)) throw new Error('Version already exists');
        versions.set(v.versionId, clone(v));
        workflows.set(workflowId, { ...wf, publishedVersion: v.versionNumber, publishedVersionId: v.versionId, publishedAt: v.publishedAt, updatedAt: v.publishedAt });
        return clone(v);
      },
    },
    versions: {
      async get(id) { return versions.has(id) ? clone(versions.get(id)!) : null; },
      async listByWorkflow(wid, limit) {
        return [...versions.values()].filter((v) => v.workflowId === wid).sort((a, b) => b.versionNumber - a.versionNumber).slice(0, limit).map(clone);
      },
      async deleteByWorkflow(wid) { for (const [k, v] of versions) if (v.workflowId === wid) versions.delete(k); },
    },
    executions: {
      async createIfAbsent(e) {
        if (executions.has(e.executionId)) return false;
        executions.set(e.executionId, clone(e));
        return true;
      },
      async get(id) { return executions.has(id) ? clone(executions.get(id)!) : null; },
      async update(id, p) { executions.set(id, { ...executions.get(id)!, ...clone(p) }); },
      async list(f, limit, cursor) {
        const all = [...executions.values()].filter((e) => matches(e, f)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.executionId.localeCompare(a.executionId));
        const start = cursor ? all.findIndex((e) => e.executionId === cursor) + 1 : 0;
        const page = all.slice(start, start + limit);
        const items = page.map(({ triggerItems, triggerNodeId, definitionJson, untilNodeId, webhookResponseJson, ...pub }) => clone(pub));
        return { items, nextCursor: start + limit < all.length ? page[page.length - 1].executionId : null };
      },
      async count(f) { return [...executions.values()].filter((e) => matches(e, f)).length; },
      async listByStatus(statuses, limit) { return [...executions.values()].filter((e) => statuses.includes(e.status)).slice(0, limit).map(clone); },
      async upsertStep(s) {
        if (!steps.has(s.executionId)) steps.set(s.executionId, new Map());
        steps.get(s.executionId)!.set(s.stepId, clone(s));
      },
      async listSteps(id) { return [...(steps.get(id)?.values() ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map(clone); },
    },
    folders: {
      async get(id) { return folders.has(id) ? clone(folders.get(id)) : null; },
      async create(f) { folders.set(f.folderId, clone(f)); },
      async update(id, p) { folders.set(id, { ...folders.get(id), ...clone(p) }); },
      async delete(id) { folders.delete(id); },
      async list(limit) { return [...folders.values()].slice(0, limit).map(clone); },
    },
    templates: {
      async get(id) { return templates.has(id) ? clone(templates.get(id)) : null; },
      async create(t) { templates.set(t.templateId, clone(t)); },
      async delete(id) { templates.delete(id); },
      async list(limit) { return [...templates.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit).map(clone); },
    },
    assistant: {
      async createChat(c) { chats.set(c.chatId, clone(c)); },
      async getChat(id) { return chats.has(id) ? clone(chats.get(id)) : null; },
      async updateChat(id, p) { if (chats.has(id)) chats.set(id, { ...chats.get(id), ...clone(p) }); },
      async listChats(owner, limit) { return [...chats.values()].filter((c) => c.ownerId === owner).sort(byNewest).slice(0, limit).map(clone); },
      async deleteChat(id) { chats.delete(id); chatMessages.delete(id); chatImages.delete(id); },
      async addImage(img) { if (!chatImages.has(img.chatId)) chatImages.set(img.chatId, new Map()); chatImages.get(img.chatId)!.set(img.imageId, clone(img)); },
      async getImage(chatId, id) { const v = chatImages.get(chatId)?.get(id); return v ? clone(v) : null; },
      async updateImage(chatId, id, p) { const box = chatImages.get(chatId); if (box?.has(id)) box.set(id, { ...box.get(id), ...clone(p) }); },
      async countImages(chatId) { return chatImages.get(chatId)?.size ?? 0; },
      async addMessage(m) { if (!chatMessages.has(m.chatId)) chatMessages.set(m.chatId, new Map()); chatMessages.get(m.chatId)!.set(m.messageId, clone(m)); },
      async updateMessage(chatId, id, p) { const box = chatMessages.get(chatId); if (box?.has(id)) box.set(id, { ...box.get(id), ...clone(p) }); },
      async listMessages(chatId, limit) {
        return [...(chatMessages.get(chatId)?.values() ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId)).slice(-limit).map(clone);
      },
      async deleteMessage(chatId, id) { chatMessages.get(chatId)?.delete(id); },
      async listMemories(owner, limit) { return [...memories.values()].filter((m) => m.ownerId === owner).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit).map(clone); },
      async addMemory(m) { memories.set(m.memoryId, clone(m)); },
      async listAllMemories(limit) { return [...memories.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit).map(clone); },
      async updateMemory(id, p) { if (memories.has(id)) memories.set(id, { ...memories.get(id), ...clone(p) }); },
      async getMemory(id) { return memories.has(id) ? clone(memories.get(id)) : null; },
      async deleteMemory(id) { memories.delete(id); },
    },
    agents: {
      async get(id) { return agents.has(id) ? clone(agents.get(id)) : null; },
      async list(limit) { return [...agents.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit).map(clone); },
      async create(a) { if (agents.has(a.agentId)) throw new Error('already exists'); agents.set(a.agentId, clone(a)); },
      async update(id, p) { if (agents.has(id)) agents.set(id, { ...agents.get(id), ...clone(p) }); },
      async delete(id) { agents.delete(id); },
    },
    agentTasks: {
      async create(t) { if (agentTasks.has(t.taskId)) throw new Error('already exists'); agentTasks.set(t.taskId, clone(t)); },
      async get(id) { return agentTasks.has(id) ? clone(agentTasks.get(id)) : null; },
      async update(id, p) { if (agentTasks.has(id)) agentTasks.set(id, { ...agentTasks.get(id), ...clone(p) }); },
      async listRecent(limit) { return [...agentTasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.taskId.localeCompare(a.taskId)).slice(0, limit).map(clone); },
      async listByStatus(st, limit) { return [...agentTasks.values()].filter((t) => st.includes(t.status)).slice(0, limit).map(clone); },
    },
    responsibilities: {
      async create(r) { responsibilities.set(r.responsibilityId, clone(r)); },
      async get(id) { return responsibilities.has(id) ? clone(responsibilities.get(id)) : null; },
      async update(id, p) { if (responsibilities.has(id)) responsibilities.set(id, { ...responsibilities.get(id), ...clone(p) }); },
      async delete(id) { responsibilities.delete(id); },
      async list(limit) { return [...responsibilities.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit).map(clone); },
    },
    usage: {
      async add(r) {
        const key = `${r.day}_${r.agentId}_${r.model}`;
        const cur = usage.get(key);
        if (!cur) usage.set(key, clone(r));
        else for (const f of ['calls', 'chatCalls', 'taskCalls', 'inputTokens', 'outputTokens'] as const) cur[f] += r[f];
      },
      async list(from, to) { return [...usage.values()].filter((r) => r.day >= from && r.day <= to).map(clone); },
    },
    knowledge: {
      async create(d, chunks) {
        if (kDocs.has(d.docId)) throw new Error('exists');
        kDocs.set(d.docId, clone(d));
        kChunks.set(d.docId, clone(chunks));
      },
      async get(id) { return kDocs.has(id) ? clone(kDocs.get(id)) : null; },
      async update(id, p) { if (kDocs.has(id)) kDocs.set(id, { ...kDocs.get(id), ...clone(p) }); },
      async replaceChunks(id, chunks) { kChunks.set(id, clone(chunks)); },
      async delete(id) { kDocs.delete(id); kChunks.delete(id); },
      async list(limit) { return [...kDocs.values()].sort((a, b) => a.title.localeCompare(b.title)).slice(0, limit).map(clone); },
      async chunks(id) { return clone(kChunks.get(id) ?? []).sort((a: any, b: any) => a.index - b.index); },
      async findChunks(terms, limit) {
        const want = new Set(terms.slice(0, 30));
        const out: any[] = [];
        for (const list of kChunks.values()) for (const c of list) if (c.terms.some((t: string) => want.has(t))) out.push(clone(c));
        return out.slice(0, limit);
      },
    },
    projects: {
      async create(p) { projects.set(p.projectId, clone(p)); },
      async get(id) { return projects.has(id) ? clone(projects.get(id)) : null; },
      async update(id, p) { if (projects.has(id)) projects.set(id, { ...projects.get(id), ...clone(p) }); },
      async listRecent(limit) { return [...projects.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.projectId.localeCompare(a.projectId)).slice(0, limit).map(clone); },
    },
    approvals: {
      async create(a) { if (approvals.has(a.approvalId)) throw new Error('already exists'); approvals.set(a.approvalId, clone(a)); },
      async get(id) { return approvals.has(id) ? clone(approvals.get(id)) : null; },
      async listRecent(limit) { return [...approvals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.approvalId.localeCompare(a.approvalId)).slice(0, limit).map(clone); },
      async listByStatus(st, limit) { return [...approvals.values()].filter((a) => a.status === st).slice(0, limit).map(clone); },
      async transition(id, from, p) {
        const a = approvals.get(id);
        if (!a || a.status !== from) return false;
        approvals.set(id, { ...a, ...clone(p) });
        return true;
      },
      async markUsed(id, at) {
        const a = approvals.get(id);
        if (!a || a.usedAt) return false;
        a.usedAt = at;
        return true;
      },
    },
    notifications: {
      async create(n) { notifications.set(n.notificationId, clone(n)); },
      async get(id) { return notifications.has(id) ? clone(notifications.get(id)) : null; },
      async listForUser(uid, limit) {
        return [...notifications.values()].filter((n) => n.userId === uid).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.notificationId.localeCompare(a.notificationId)).slice(0, limit).map(clone);
      },
      async markRead(id) { if (notifications.has(id)) notifications.get(id).read = true; },
      async markAllRead(uid) {
        let n = 0;
        for (const x of notifications.values()) if (x.userId === uid && !x.read) { x.read = true; n++; }
        return n;
      },
    },
    agentSchedules: {
      async create(s) { agentSchedules.set(s.scheduleId, clone(s)); },
      async get(id) { return agentSchedules.has(id) ? clone(agentSchedules.get(id)) : null; },
      async update(id, p) { if (agentSchedules.has(id)) agentSchedules.set(id, { ...agentSchedules.get(id), ...clone(p) }); },
      async delete(id) { agentSchedules.delete(id); },
      async list(limit) { return [...agentSchedules.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit).map(clone); },
    },
    settings: {
      async get(key) { return settings.has(key) ? clone(settings.get(key)) as any : null; },
      async set(key, value) { settings.set(key, clone(value)); },
    },
    chatMemory: {
      async get(id) { return chatMemory.has(id) ? clone(chatMemory.get(id)) : null; },
      async set(id, v) { chatMemory.set(id, clone(v)); },
      async delete(id) { chatMemory.delete(id); },
    },
    webhooks: {
      async create(w) { webhooks.set(w.webhookId, clone(w)); },
      async findByTokenHash(h) { const w = [...webhooks.values()].find((x) => x.endpointTokenHash === h); return w ? clone(w) : null; },
      async listByWorkflow(wid) { return [...webhooks.values()].filter((w) => w.workflowId === wid).map(clone); },
      async update(id, p) { webhooks.set(id, { ...webhooks.get(id)!, ...clone(p) }); },
      async delete(id) { webhooks.delete(id); },
    },
    credentials: {
      async get(id) { return creds.has(id) ? clone(creds.get(id)!) : null; },
      async list(limit) { return [...creds.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit).map(clone); },
      async create(c) { creds.set(c.credentialId, clone(c)); },
      async update(id, p) { creds.set(id, { ...creds.get(id)!, ...clone(p) }); },
      async delete(id) { creds.delete(id); },
    },
    credentialSecrets: {
      async get(id) { return secrets.get(id) ?? null; },
      async set(id, v) { secrets.set(id, v); },
      async delete(id) { secrets.delete(id); },
    },
    audit: {
      async add(l) { audit.unshift(clone(l)); },
      async list(limit, cursor) {
        const start = cursor ? audit.findIndex((a) => a.logId === cursor) + 1 : 0;
        const items = audit.slice(start, start + limit).map(clone);
        return { items, nextCursor: start + limit < audit.length ? items[items.length - 1].logId : null };
      },
    },
  };
}
