import { FieldValue, Timestamp, type Firestore, type Query } from 'firebase-admin/firestore';
import type { Credential, Execution, ExecutionStep, Workflow, WorkflowVersion } from '@widebed/shared';
import type { AuditLog, ExecutionFilter, Repositories, StoredExecution, WebhookEndpoint } from './types.js';

/**
 * Firestore implementation.
 *
 * Collections
 *   users/{uid}
 *   workflows/{workflowId}
 *   workflowVersions/{workflowId}_v{n}            immutable snapshots
 *   workflowExecutions/{executionId}
 *   workflowExecutions/{executionId}/steps/{id}   one doc per node run
 *   workflowFolders/{folderId}
 *   webhookEndpoints/{webhookId}
 *   auditLogs/{logId}
 *   systemSettings/{settingId}
 *
 * Execution and step documents carry `expireAt` (Timestamp). A Firestore TTL
 * policy on that field enforces the retention period (see docs/DEPLOYMENT.md).
 *
 * Step input/output payloads are stored as JSON strings: arbitrary user data
 * may contain nested arrays, which Firestore cannot store natively.
 */
export function createFirestoreRepositories(db: Firestore, opts: { retentionDays: number }): Repositories {
  const C = {
    users: db.collection('users'),
    workflows: db.collection('workflows'),
    versions: db.collection('workflowVersions'),
    executions: db.collection('workflowExecutions'),
    folders: db.collection('workflowFolders'),
    templates: db.collection('workflowTemplates'),
    chats: db.collection('assistantChats'),
    memories: db.collection('assistantMemories'),
    agents: db.collection('aiAgents'),
    agentTasks: db.collection('aiTasks'),
    agentSchedules: db.collection('aiSchedules'),
    responsibilities: db.collection('aiResponsibilities'),
    notifications: db.collection('aiNotifications'),
    approvals: db.collection('aiApprovals'),
    projects: db.collection('aiProjects'),
    knowledge: db.collection('aiKnowledge'),
    usage: db.collection('aiUsage'),
    webhooks: db.collection('webhookEndpoints'),
    audit: db.collection('auditLogs'),
    settings: db.collection('systemSettings'),
    chatMemory: db.collection('workflowChatMemory'),
    credentials: db.collection('credentials'),
    secrets: db.collection('credentialSecrets'),
  };

  const writeChunks = async (ref: FirebaseFirestore.DocumentReference, chunks: { index: number }[]) => {
    for (let i = 0; i < chunks.length; i += 400) {
      const batch = db.batch();
      for (const c of chunks.slice(i, i + 400)) batch.set(ref.collection('knowledgeChunks').doc(String(c.index).padStart(4, '0')), c);
      await batch.commit();
    }
  };
  const deleteAll = async (col: FirebaseFirestore.CollectionReference) => {
    for (;;) {
      const snap = await col.limit(400).get();
      if (snap.empty) return;
      const batch = db.batch();
      for (const d of snap.docs) batch.delete(d.ref);
      await batch.commit();
    }
  };

  const expireAt = () => Timestamp.fromMillis(Date.now() + opts.retentionDays * 86400_000);
  const data = <T>(snap: FirebaseFirestore.DocumentSnapshot): T | null => (snap.exists ? (snap.data() as T) : null);

  const toStoredExec = (raw: any): StoredExecution => {
    const { expireAt: _e, triggerItemsJson, ...rest } = raw;
    return { ...rest, triggerItems: triggerItemsJson ? JSON.parse(triggerItemsJson) : null };
  };
  const toPublicExec = (raw: any): Execution => {
    const { expireAt: _e, triggerItemsJson: _t, triggerNodeId: _n, definitionJson: _d, untilNodeId: _u, ...rest } = raw;
    return rest;
  };
  const fromStoredExec = (e: Partial<StoredExecution>) => {
    const { triggerItems, ...rest } = e;
    const out: Record<string, unknown> = { ...rest };
    if (triggerItems !== undefined) out.triggerItemsJson = triggerItems ? JSON.stringify(triggerItems) : null;
    return out;
  };

  function applyExecFilter(q: Query, f: ExecutionFilter): Query {
    if (f.workflowId) q = q.where('workflowId', '==', f.workflowId);
    if (f.status) q = q.where('status', '==', f.status);
    if (f.triggerType) q = q.where('triggerType', '==', f.triggerType);
    if (f.department) q = q.where('department', '==', f.department);
    if (f.initiatedBy) q = q.where('initiatedBy', '==', f.initiatedBy);
    if (f.from) q = q.where('createdAt', '>=', f.from);
    if (f.to) q = q.where('createdAt', '<=', f.to);
    return q;
  }

  const wfList = async (q: Query, limit: number) =>
    (await q.orderBy('updatedAt', 'desc').limit(limit).get()).docs.map((d) => d.data() as Workflow);

  return {
    async ping() {
      await C.settings.doc('_health').get();
    },

    users: {
      async get(uid) { return data(await C.users.doc(uid).get()); },
      async create(u) { await C.users.doc(u.uid).create(u); },
      async update(uid, p) { await C.users.doc(uid).update(p); },
      async list(limit) { return (await C.users.orderBy('createdAt', 'desc').limit(limit).get()).docs.map((d) => d.data() as any); },
    },

    workflows: {
      async get(id) { return data(await C.workflows.doc(id).get()); },
      async create(wf) { await C.workflows.doc(wf.workflowId).create(wf); },
      async update(id, p) { await C.workflows.doc(id).update(p); },
      async delete(id) { await C.workflows.doc(id).delete(); },
      listAll: (limit) => wfList(C.workflows, limit),
      listByDepartment: (d, limit) => wfList(C.workflows.where('department', '==', d), limit),
      listByOwner: (uid, limit) => wfList(C.workflows.where('ownerId', '==', uid), limit),
      listSharedWith: (uid, limit) => wfList(C.workflows.where('sharedWith', 'array-contains', uid), limit),
      async count(f) {
        const q = f.status ? C.workflows.where('status', '==', f.status) : C.workflows;
        return (await q.count().get()).data().count;
      },
      async listActiveByEvent(name, limit) {
        const snap = await C.workflows.where('eventTriggers', 'array-contains', name).where('status', '==', 'active').limit(limit).get();
        return snap.docs.map((d) => d.data() as Workflow);
      },
      async listActive(limit) {
        return (await C.workflows.where('status', '==', 'active').limit(limit).get()).docs.map((d) => d.data() as Workflow);
      },
      async publish(workflowId, build) {
        return db.runTransaction(async (tx) => {
          const ref = C.workflows.doc(workflowId);
          const snap = await tx.get(ref);
          if (!snap.exists) throw new Error('Workflow not found');
          const wf = snap.data() as Workflow;
          const version = build((wf.publishedVersion ?? 0) + 1, wf);
          // create() fails if the id exists, so two concurrent publishes cannot share a number.
          tx.create(C.versions.doc(version.versionId), version);
          tx.update(ref, {
            publishedVersion: version.versionNumber,
            publishedVersionId: version.versionId,
            publishedAt: version.publishedAt,
            updatedAt: version.publishedAt,
          });
          return version;
        });
      },
    },

    versions: {
      async get(id) { return data(await C.versions.doc(id).get()); },
      async listByWorkflow(wid, limit) {
        return (await C.versions.where('workflowId', '==', wid).orderBy('versionNumber', 'desc').limit(limit).get()).docs.map((d) => d.data() as WorkflowVersion);
      },
      async deleteByWorkflow(wid) {
        const snaps = await C.versions.where('workflowId', '==', wid).get();
        const writer = db.bulkWriter();
        snaps.docs.forEach((d) => writer.delete(d.ref));
        await writer.close();
      },
    },

    executions: {
      async createIfAbsent(e) {
        try {
          await C.executions.doc(e.executionId).create({ ...fromStoredExec(e), expireAt: expireAt() });
          return true;
        } catch (err: any) {
          if (err?.code === 6 /* ALREADY_EXISTS */) return false;
          throw err;
        }
      },
      async get(id) {
        const snap = await C.executions.doc(id).get();
        return snap.exists ? toStoredExec(snap.data()) : null;
      },
      async update(id, p) { await C.executions.doc(id).update(fromStoredExec(p)); },
      async list(f, limit, cursor) {
        let q = applyExecFilter(C.executions, f).orderBy('createdAt', 'desc');
        if (cursor) {
          const cur = await C.executions.doc(cursor).get();
          if (cur.exists) q = q.startAfter(cur);
        }
        const snap = await q.limit(limit + 1).get();
        const docs = snap.docs.slice(0, limit);
        return {
          items: docs.map((d) => toPublicExec(d.data())),
          nextCursor: snap.docs.length > limit ? docs[docs.length - 1].id : null,
        };
      },
      async count(f) { return (await applyExecFilter(C.executions, f).count().get()).data().count; },
      async listByStatus(statuses, limit) {
        return (await C.executions.where('status', 'in', statuses).limit(limit).get()).docs.map((d) => toStoredExec(d.data()));
      },
      async upsertStep(s) {
        const { inputData, outputData, ...rest } = s;
        await C.executions.doc(s.executionId).collection('steps').doc(s.stepId).set({
          ...rest,
          inputJson: JSON.stringify(inputData ?? null),
          outputJson: JSON.stringify(outputData ?? null),
          expireAt: expireAt(),
        });
      },
      async listSteps(id) {
        const snap = await C.executions.doc(id).collection('steps').orderBy('startedAt', 'asc').limit(500).get();
        return snap.docs.map((d) => {
          const { inputJson, outputJson, expireAt: _e, ...rest } = d.data();
          return { ...rest, inputData: JSON.parse(inputJson ?? 'null'), outputData: JSON.parse(outputJson ?? 'null') } as ExecutionStep;
        });
      },
    },

    folders: {
      async get(id) { return data(await C.folders.doc(id).get()); },
      async create(f) { await C.folders.doc(f.folderId).create(f); },
      async update(id, p) { await C.folders.doc(id).update(p); },
      async delete(id) { await C.folders.doc(id).delete(); },
      async list(limit) { return (await C.folders.orderBy('name').limit(limit).get()).docs.map((d) => d.data() as any); },
    },

    templates: {
      // The definition is stored as a JSON string: Firestore cannot store nested arrays.
      async get(id) {
        const raw = data<any>(await C.templates.doc(id).get());
        if (!raw) return null;
        const { definitionJson, ...rest } = raw;
        return { ...rest, definition: JSON.parse(definitionJson) };
      },
      async create(t) {
        const { definition, ...rest } = t;
        await C.templates.doc(t.templateId).create({ ...rest, definitionJson: JSON.stringify(definition) });
      },
      async delete(id) { await C.templates.doc(id).delete(); },
      async list(limit) {
        return (await C.templates.orderBy('name').limit(limit).get()).docs.map((d) => {
          const { definitionJson, ...rest } = d.data() as any;
          return { ...rest, definition: JSON.parse(definitionJson) };
        });
      },
    },

    agentTasks: {
      // expireAt: the TTL policy on aiTasks removes old tasks like old executions (see DEPLOYMENT).
      async create(t) { await C.agentTasks.doc(t.taskId).create({ ...t, expireAt: expireAt() }); },
      async get(id) {
        const t = data<any>(await C.agentTasks.doc(id).get());
        if (!t) return null;
        const { expireAt: _e, ...rest } = t;
        return rest;
      },
      async update(id, p) { await C.agentTasks.doc(id).update(p); },
      async listRecent(limit) {
        return (await C.agentTasks.orderBy('createdAt', 'desc').limit(limit).get()).docs.map((d) => {
          const { expireAt: _e, ...rest } = d.data() as any;
          return rest;
        });
      },
      async listByStatus(st, limit) {
        return (await C.agentTasks.where('status', 'in', st).limit(limit).get()).docs.map((d) => {
          const { expireAt: _e, ...rest } = d.data() as any;
          return rest;
        });
      },
    },
    responsibilities: {
      async create(r) { await C.responsibilities.doc(r.responsibilityId).create(r); },
      async get(id) { return data(await C.responsibilities.doc(id).get()); },
      async update(id, p) { await C.responsibilities.doc(id).update(p); },
      async delete(id) { await C.responsibilities.doc(id).delete(); },
      async list(limit) {
        const rows = (await C.responsibilities.limit(limit).get()).docs.map((d) => d.data() as any);
        return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      },
    },
    usage: {
      // aiUsage/{day}_{agentId}_{model}: counters added with increment (safe when calls finish at the same time).
      async add(r) {
        const id = `${r.day}_${r.agentId}_${r.model}`.replace(/\//g, '_').slice(0, 400);
        const inc = (n: number) => FieldValue.increment(n);
        await C.usage.doc(id).set(
          { day: r.day, agentId: r.agentId, agentName: r.agentName, department: r.department, model: r.model, calls: inc(r.calls), chatCalls: inc(r.chatCalls), taskCalls: inc(r.taskCalls), inputTokens: inc(r.inputTokens), outputTokens: inc(r.outputTokens) },
          { merge: true },
        );
      },
      async list(from, to) {
        return (await C.usage.where('day', '>=', from).where('day', '<=', to).get()).docs.map((d) => d.data() as any);
      },
    },
    knowledge: {
      // aiKnowledge/{docId} + aiKnowledge/{docId}/knowledgeChunks/{index}. Text only — no files.
      async create(d, chunks) {
        const ref = C.knowledge.doc(d.docId);
        await ref.create(d);
        await writeChunks(ref, chunks);
      },
      async get(id) { return data(await C.knowledge.doc(id).get()); },
      async update(id, p) { await C.knowledge.doc(id).update(p); },
      async replaceChunks(id, chunks) {
        const ref = C.knowledge.doc(id);
        await deleteAll(ref.collection('knowledgeChunks'));
        await writeChunks(ref, chunks);
      },
      async delete(id) {
        const ref = C.knowledge.doc(id);
        await deleteAll(ref.collection('knowledgeChunks'));
        await ref.delete();
      },
      async list(limit) {
        const rows = (await C.knowledge.limit(limit).get()).docs.map((d) => d.data() as any);
        return rows.sort((a, b) => String(a.title).localeCompare(String(b.title)));
      },
      async chunks(id) {
        return (await C.knowledge.doc(id).collection('knowledgeChunks').orderBy('index').get()).docs.map((d) => d.data() as any);
      },
      async findChunks(terms, limit) {
        if (!terms.length) return [];
        const q = db.collectionGroup('knowledgeChunks').where('terms', 'array-contains-any', terms.slice(0, 30)).limit(limit);
        return (await q.get()).docs.map((d) => d.data() as any);
      },
    },
    projects: {
      async create(p) { await C.projects.doc(p.projectId).create(p); },
      async get(id) { return data(await C.projects.doc(id).get()); },
      async update(id, p) { await C.projects.doc(id).update(p); },
      async listRecent(limit) { return (await C.projects.orderBy('createdAt', 'desc').limit(limit).get()).docs.map((d) => d.data() as any); },
    },
    approvals: {
      async create(a) { await C.approvals.doc(a.approvalId).create(a); },
      async get(id) { return data(await C.approvals.doc(id).get()); },
      async listRecent(limit) { return (await C.approvals.orderBy('createdAt', 'desc').limit(limit).get()).docs.map((d) => d.data() as any); },
      async listByStatus(st, limit) { return (await C.approvals.where('status', '==', st).limit(limit).get()).docs.map((d) => d.data() as any); },
      async transition(id, from, p) {
        // A transaction: two people pressing Approve at the same moment can't both win.
        return db.runTransaction(async (tx) => {
          const ref = C.approvals.doc(id);
          const snap = await tx.get(ref);
          if (!snap.exists || snap.get('status') !== from) return false;
          tx.update(ref, p as any);
          return true;
        });
      },
      async markUsed(id, at) {
        return db.runTransaction(async (tx) => {
          const ref = C.approvals.doc(id);
          const snap = await tx.get(ref);
          if (!snap.exists || snap.get('usedAt')) return false;
          tx.update(ref, { usedAt: at });
          return true;
        });
      },
    },
    notifications: {
      // expireAt: TTL removes old notices (60 days).
      async create(n) { await C.notifications.doc(n.notificationId).create({ ...n, expireAt: new Date(Date.now() + 60 * 86400_000) }); },
      async get(id) {
        const n = data<any>(await C.notifications.doc(id).get());
        if (!n) return null;
        const { expireAt: _e, ...rest } = n;
        return rest;
      },
      async listForUser(uid, limit) {
        // Equality only (no composite index); newest first in memory.
        const rows = (await C.notifications.where('userId', '==', uid).limit(300).get()).docs.map((d) => {
          const { expireAt: _e, ...rest } = d.data() as any;
          return rest;
        });
        return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
      },
      async markRead(id) { await C.notifications.doc(id).update({ read: true }); },
      async markAllRead(uid) {
        const snap = await C.notifications.where('userId', '==', uid).where('read', '==', false).limit(500).get();
        const batch = db.batch();
        snap.docs.forEach((d) => batch.update(d.ref, { read: true }));
        if (!snap.empty) await batch.commit();
        return snap.size;
      },
    },
    agentSchedules: {
      async create(s) { await C.agentSchedules.doc(s.scheduleId).create(s); },
      async get(id) { return data(await C.agentSchedules.doc(id).get()); },
      async update(id, p) { await C.agentSchedules.doc(id).update(p); },
      async delete(id) { await C.agentSchedules.doc(id).delete(); },
      async list(limit) {
        const rows = (await C.agentSchedules.limit(limit).get()).docs.map((d) => d.data() as any);
        return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      },
    },
    agents: {
      async get(id) { return data(await C.agents.doc(id).get()); },
      async list(limit) {
        const rows = (await C.agents.limit(500).get()).docs.map((d) => d.data() as any);
        return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(0, limit);
      },
      async create(a) { await C.agents.doc(a.agentId).create(a); },
      async update(id, p) { await C.agents.doc(id).update(p); },
      async delete(id) { await C.agents.doc(id).delete(); },
    },
    assistant: {
      async createChat(c) { await C.chats.doc(c.chatId).create(c); },
      async getChat(id) { return data(await C.chats.doc(id).get()); },
      async updateChat(id, p) { await C.chats.doc(id).update(p); },
      // Equality-only queries need no composite index (works right after deploy); sorted here.
      async listChats(owner, limit) {
        const rows = (await C.chats.where('ownerId', '==', owner).limit(300).get()).docs.map((d) => d.data() as any);
        return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
      },
      async deleteChat(id) {
        const ref = C.chats.doc(id);
        for (const sub of ['messages', 'images']) {
          for (;;) {
            const snap = await ref.collection(sub).limit(sub === 'images' ? 20 : 300).get();
            if (snap.empty) break;
            const batch = db.batch();
            snap.docs.forEach((d) => batch.delete(d.ref));
            await batch.commit();
          }
        }
        await ref.delete();
      },
      // Photos: assistantChats/{chatId}/images/{imageId}, compressed, base64 (each < 1 MB).
      async addImage(img) { await C.chats.doc(img.chatId).collection('images').doc(img.imageId).create(img); },
      async getImage(chatId, id) { return data(await C.chats.doc(chatId).collection('images').doc(id).get()); },
      async updateImage(chatId, id, p) { await C.chats.doc(chatId).collection('images').doc(id).update(p); },
      async countImages(chatId) { return (await C.chats.doc(chatId).collection('images').count().get()).data().count; },
      async addMessage(m) { await C.chats.doc(m.chatId).collection('messages').doc(m.messageId).create(m); },
      async updateMessage(chatId, id, p) { await C.chats.doc(chatId).collection('messages').doc(id).update(p); },
      async listMessages(chatId, limit) {
        const snap = await C.chats.doc(chatId).collection('messages').orderBy('createdAt', 'desc').limit(limit).get();
        return snap.docs.map((d) => d.data() as any).reverse();
      },
      async deleteMessage(chatId, id) { await C.chats.doc(chatId).collection('messages').doc(id).delete(); },
      async listMemories(owner, limit) {
        const rows = (await C.memories.where('ownerId', '==', owner).limit(1000).get()).docs.map((d) => d.data() as any);
        return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(0, limit);
      },
      async addMemory(m) { await C.memories.doc(m.memoryId).create(m); },
      async listAllMemories(limit) {
        const rows = (await C.memories.limit(limit).get()).docs.map((d) => d.data() as any);
        return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      },
      async updateMemory(id, p) { await C.memories.doc(id).update(p); },
      async getMemory(id) { return data(await C.memories.doc(id).get()); },
      async deleteMemory(id) { await C.memories.doc(id).delete(); },
    },
    settings: {
      async get(key) { const raw = data<any>(await C.settings.doc(key).get()); return raw ? (raw.settingValue as any) : null; },
      async set(key, value) { await C.settings.doc(key).set({ settingValue: value, updatedAt: new Date().toISOString() }); },
    },

    chatMemory: {
      async get(id) { const raw = data<any>(await C.chatMemory.doc(id).get()); if (!raw) return null; const { expireAt: _e, ...rest } = raw; return rest; },
      async set(id, value) { await C.chatMemory.doc(id).set({ ...value, expireAt: Timestamp.fromMillis(Date.now() + 90 * 86400_000) }); },
      async delete(id) { await C.chatMemory.doc(id).delete(); },
    },

    webhooks: {
      async create(w) { await C.webhooks.doc(w.webhookId).create(w); },
      async findByTokenHash(h) {
        const snap = await C.webhooks.where('endpointTokenHash', '==', h).limit(1).get();
        return snap.empty ? null : (snap.docs[0].data() as WebhookEndpoint);
      },
      async listByWorkflow(wid) { return (await C.webhooks.where('workflowId', '==', wid).get()).docs.map((d) => d.data() as WebhookEndpoint); },
      async update(id, p) { await C.webhooks.doc(id).update(p); },
      async delete(id) { await C.webhooks.doc(id).delete(); },
    },

    credentials: {
      async get(id) { return data<Credential>(await C.credentials.doc(id).get()); },
      async list(limit) { return (await C.credentials.orderBy('name').limit(limit).get()).docs.map((d) => d.data() as Credential); },
      async create(c) { await C.credentials.doc(c.credentialId).create(c); },
      async update(id, p) { await C.credentials.doc(id).update(p); },
      async delete(id) { await C.credentials.doc(id).delete(); },
    },
    credentialSecrets: {
      async get(id) { return (await C.secrets.doc(id).get()).data()?.encrypted ?? null; },
      async set(id, v) { await C.secrets.doc(id).set({ encrypted: v, updatedAt: new Date().toISOString() }); },
      async delete(id) { await C.secrets.doc(id).delete(); },
    },
    audit: {
      async add(l) { await C.audit.doc(l.logId).set({ ...l, createdAtServer: FieldValue.serverTimestamp() }); },
      async list(limit, cursor) {
        let q = C.audit.orderBy('timestamp', 'desc');
        if (cursor) {
          const cur = await C.audit.doc(cursor).get();
          if (cur.exists) q = q.startAfter(cur);
        }
        const snap = await q.limit(limit + 1).get();
        const docs = snap.docs.slice(0, limit);
        return {
          items: docs.map((d) => { const { createdAtServer: _c, ...rest } = d.data(); return rest as AuditLog; }),
          nextCursor: snap.docs.length > limit ? docs[docs.length - 1].id : null,
        };
      },
    },
  };
}
