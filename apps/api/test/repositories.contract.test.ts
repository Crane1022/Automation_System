import { describe, expect, it } from 'vitest';
import type { Workflow } from '@widebed/shared';
import { emptyDefinition } from '@widebed/shared';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { Repositories, StoredExecution } from '../src/repositories/types.js';

/**
 * The same contract runs against every repository implementation.
 * Firestore runs only when the emulator is available:
 *   firebase emulators:exec --only firestore "npm test"
 */
const targets: [string, () => Promise<Repositories>][] = [['memory', async () => createMemoryRepositories()]];

if (process.env.FIRESTORE_EMULATOR_HOST) {
  targets.push([
    'firestore (emulator)',
    async () => {
      const { initializeApp, getApps } = await import('firebase-admin/app');
      const { getFirestore } = await import('firebase-admin/firestore');
      const { createFirestoreRepositories } = await import('../src/repositories/firestore.js');
      const app = getApps()[0] ?? initializeApp({ projectId: `contract-${Date.now()}` });
      const db = getFirestore(app);
      try { db.settings({ ignoreUndefinedProperties: true }); } catch { /* already set */ }
      return createFirestoreRepositories(db, { retentionDays: 1 });
    },
  ]);
}

const suffix = Math.random().toString(36).slice(2, 8);
const wf = (id: string, extra: Partial<Workflow> = {}): Workflow => ({
  workflowId: `${id}_${suffix}`, name: id, description: '', folderId: null, ownerId: 'u1', department: 'Ops',
  status: 'inactive', tags: [], sharedWith: [], draftDefinition: emptyDefinition(), publishedVersion: null,
  publishedVersionId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), publishedAt: null, ...extra,
});
const exe = (id: string, extra: Partial<StoredExecution> = {}): StoredExecution => ({
  executionId: `${id}_${suffix}`, workflowId: `w_${suffix}`, workflowName: 'W', department: 'Ops', workflowVersion: 1, workflowVersionId: 'v',
  isTestRun: false, status: 'success', triggerType: 'manual', initiatedBy: 'u1', idempotencyKey: null, retryOf: null,
  createdAt: new Date().toISOString(), startedAt: null, completedAt: null, duration: null, errorSummary: null, stepCount: 0,
  triggerItems: [{ json: { nested: [[1, 2], [3]] } }], triggerNodeId: 't', ...extra,
});

for (const [name, make] of targets) {
  describe(`repository contract: ${name}`, () => {
    it('publishes versions with increasing numbers', async () => {
      const r = await make();
      const w = wf('pub');
      await r.workflows.create(w);
      for (const expected of [1, 2]) {
        const v = await r.workflows.publish(w.workflowId, (n, cur) => ({
          versionId: `${cur.workflowId}_v${n}`, workflowId: cur.workflowId, versionNumber: n, nodes: [], connections: [], publishedBy: 'u1', publishedAt: new Date().toISOString(),
        }));
        expect(v.versionNumber).toBe(expected);
      }
      expect((await r.workflows.get(w.workflowId))!.publishedVersion).toBe(2);
      expect((await r.versions.listByWorkflow(w.workflowId, 10)).map((v) => v.versionNumber)).toEqual([2, 1]);
    });

    it('creates executions idempotently and keeps nested trigger data', async () => {
      const r = await make();
      const e = exe('idem');
      expect(await r.executions.createIfAbsent(e)).toBe(true);
      expect(await r.executions.createIfAbsent(e)).toBe(false);
      expect((await r.executions.get(e.executionId))!.triggerItems).toEqual(e.triggerItems);
    });

    it('filters and paginates executions newest first', async () => {
      const r = await make();
      const wid = `page_${suffix}`;
      for (let i = 0; i < 5; i++) {
        await r.executions.createIfAbsent(exe(`p${i}`, { workflowId: wid, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), status: i % 2 ? 'failed' : 'success' }));
      }
      const p1 = await r.executions.list({ workflowId: wid }, 2);
      expect(p1.items.map((e) => e.executionId)).toEqual([`p4_${suffix}`, `p3_${suffix}`]);
      expect((p1.items[0] as any).triggerItems).toBeUndefined();
      const p2 = await r.executions.list({ workflowId: wid }, 2, p1.nextCursor!);
      expect(p2.items.map((e) => e.executionId)).toEqual([`p2_${suffix}`, `p1_${suffix}`]);
      expect(await r.executions.count({ workflowId: wid, status: 'failed' })).toBe(2);
    });

    it('stores steps with arbitrary JSON', async () => {
      const r = await make();
      const e = exe('steps');
      await r.executions.createIfAbsent(e);
      await r.executions.upsertStep({
        stepId: 's1', executionId: e.executionId, nodeId: 'n', nodeName: 'N', nodeType: 't', status: 'success', attempt: 1,
        inputData: [[1, [2]]], outputData: { main: [{ a: [[1]] }] }, error: null, startedAt: new Date().toISOString(), completedAt: null, duration: 1,
      });
      const steps = await r.executions.listSteps(e.executionId);
      expect(steps[0].inputData).toEqual([[1, [2]]]);
    });

    it('lists workflows by owner, department and sharing', async () => {
      const r = await make();
      await r.workflows.create(wf('own', { ownerId: `x_${suffix}`, department: `D_${suffix}` }));
      await r.workflows.create(wf('shared', { sharedWith: [`x_${suffix}`] }));
      expect((await r.workflows.listByOwner(`x_${suffix}`, 10)).length).toBe(1);
      expect((await r.workflows.listByDepartment(`D_${suffix}`, 10)).length).toBe(1);
      expect((await r.workflows.listSharedWith(`x_${suffix}`, 10)).length).toBe(1);
    });

    it('stores templates with their whole definition', async () => {
      const r = await make();
      const def = { ...emptyDefinition(), nodes: [{ id: 'a', type: 'logic.filter', name: 'A', position: { x: 0, y: 0 }, config: { conditions: [{ left: 1, operator: 'equals', right: [1, [2]] }] } }] };
      const t = { templateId: `tpl_${suffix}`, name: `T ${suffix}`, description: 'd', category: 'Custom' as const, needs: [], setup: [], definition: def, builtIn: false, createdBy: 'u1', createdByName: 'U', createdAt: new Date().toISOString() };
      await r.templates.create(t);
      expect(await r.templates.get(t.templateId)).toEqual(t);
      expect((await r.templates.list(500)).some((x) => x.templateId === t.templateId && x.definition.nodes.length === 1)).toBe(true);
      await r.templates.delete(t.templateId);
      expect(await r.templates.get(t.templateId)).toBeNull();
    });
  });
}
