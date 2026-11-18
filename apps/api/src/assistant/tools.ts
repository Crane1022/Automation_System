import { DEFAULT_AGENT_ID, canRunWorkflow, memorySecretProblem, type AppUser } from '@widebed/shared';
import { evaluateCondition, type FirestoreOp } from '@widebed/nodes';
import type { AgentTool } from './agent.js';
import type { Repositories } from '../repositories/types.js';
import type { CredentialService } from '../services/credential-service.js';
import type { ExecutionService } from '../services/execution-service.js';
import { newId, nowIso } from '../lib/ids.js';

/* ------------------------------------------------------------------ memory */

export const MAX_MEMORIES = 100;

/** Memories of one person with one AI employee (old memories without agentId belong to the Widebed Assistant). */
export async function agentMemories(repos: Repositories, ownerId: string, agentId: string) {
  return (await repos.assistant.listMemories(ownerId, 1000)).filter((m) => (m.agentId ?? DEFAULT_AGENT_ID) === agentId);
}

export function memoryTools(repos: Repositories, user: AppUser, agentId: string = DEFAULT_AGENT_ID): AgentTool[] {
  return [
    {
      name: 'remember',
      description: 'Save a lasting fact or preference about the person or their work, so you know it in future chats (e.g. “Unit A-12’s TNB account is 2200-1234”). Keep it to one short sentence.',
      input: '{ "fact": "the sentence to remember" }',
      label: () => 'Remembering this',
      async run(input) {
        const text = String(input?.fact ?? '').trim().slice(0, 300);
        if (!text) throw new Error('Nothing to remember');
        const secret = memorySecretProblem(text);
        if (secret) throw new Error(`Not saved. ${secret} Tell the person you did not save it.`);
        const list = await agentMemories(repos, user.uid, agentId);
        if (list.length >= MAX_MEMORIES) throw new Error(`The memory is full (${MAX_MEMORIES} items). Ask the person to delete old ones in “What I remember”.`);
        if (list.some((m) => m.text.toLowerCase() === text.toLowerCase())) return 'Already remembered.';
        const memoryId = newId('mem');
        await repos.assistant.addMemory({ memoryId, ownerId: user.uid, agentId, text, createdAt: nowIso() });
        return `Saved as ${memoryId}.`;
      },
    },
    {
      name: 'forget',
      description: 'Delete something you remembered, when the person asks you to forget it or it is no longer true.',
      input: '{ "memoryId": "mem_…" }',
      label: () => 'Forgetting this',
      async run(input) {
        const m = await repos.assistant.getMemory(String(input?.memoryId ?? ''));
        if (!m || m.ownerId !== user.uid || (m.agentId ?? DEFAULT_AGENT_ID) !== agentId) throw new Error('No such memory');
        await repos.assistant.deleteMemory(m.memoryId);
        return 'Forgotten.';
      },
    },
  ];
}

/* --------------------------------------------------------------- workflows */

const TERMINAL = ['success', 'failed', 'cancelled'];

export function workflowTools(repos: Repositories, executions: ExecutionService, user: AppUser, opts: { waitMs?: number; pollMs?: number } = {}): AgentTool[] {
  const runnable = async () => (await repos.workflows.listAll(500)).filter((w) => w.publishedVersionId && canRunWorkflow(user, w));
  return [
    {
      name: 'list_workflows',
      description: 'List the published workflows the person may run (name, id, what it does). Use before run_workflow.',
      input: '{}',
      label: () => 'Looking at your workflows',
      async run() {
        const list = await runnable();
        return list.length ? list.map((w) => ({ id: w.workflowId, name: w.name, description: w.description, active: w.status === 'active' })) : 'There are no published workflows this person can run.';
      },
    },
    {
      name: 'run_workflow',
      description: 'Run one of the person’s published workflows now (e.g. send the rent reminders). It may send emails or change data, so the person is asked to approve first. Optionally pass data the workflow receives as its trigger item.',
      input: '{ "workflowId": "wf_…", "workflowName": "its name (shown to the person)", "data": { optional fields for the workflow } }',
      label: (i) => `Running workflow ${i?.workflowName ?? i?.workflowId ?? ''}`.trim(),
      risk: () => 3,
      target: 'Workflows',
      approval: (i) => `Run the workflow “${i?.workflowName ?? i?.workflowId}” now${i?.data && Object.keys(i.data).length ? ` with ${JSON.stringify(i.data).slice(0, 300)}` : ''}. It may send emails or change data.`,
      async run(input, ctx) {
        const wf = await repos.workflows.get(String(input?.workflowId ?? ''));
        if (!wf || !wf.publishedVersionId || !canRunWorkflow(user, wf)) throw new Error('That workflow does not exist, is not published, or this person may not run it');
        const data = input?.data && typeof input.data === 'object' && !Array.isArray(input.data) ? input.data : {};
        const { executionId } = await executions.start({ workflow: wf, mode: 'published', triggerType: 'manual', triggerItems: [{ json: data }], initiatedBy: user.uid });
        ctx.progress(`Started run ${executionId}`);
        const until = Date.now() + (opts.waitMs ?? 90_000);
        while (Date.now() < until && !ctx.signal.aborted) {
          const e = await repos.executions.get(executionId);
          if (e && TERMINAL.includes(e.status)) {
            const steps = await repos.executions.listSteps(executionId);
            const last = [...steps].reverse().find((s) => s.status === 'success');
            return {
              executionId,
              status: e.status,
              error: e.errorSummary ?? null,
              steps: steps.map((s) => `${s.nodeName}: ${s.status}`),
              lastOutput: last?.outputData ?? null,
            };
          }
          await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000));
        }
        return { executionId, status: 'still running', note: 'It is still running. The person can follow it on the Executions page.' };
      },
    },
  ];
}

/* --------------------------------------------------------------------- PMS */

const OPS: FirestoreOp[] = ['==', '!=', '<', '<=', '>', '>=', 'array-contains', 'in'];
const DATE_CHECKS = ['moreThanDaysAgo', 'withinLastDays', 'withinNextDays', 'isDaysFromToday', 'isToday', 'isTomorrow', 'isYesterday', 'isInPast', 'isInFuture'] as const;

export function pmsTools(credentials: CredentialService, credentialId: string, department: string | null, allowed: string[]): AgentTool[] {
  const access = () => credentials.firestoreAccess(credentialId, department);
  const list = allowed.join(', ');
  return [
    {
      name: 'pms_query',
      description:
        `Read data from Widebed PMS (read-only). Collections you may read: ${list}. ` +
        'Useful ones: offlineBookings (arrival, departure "YYYY-MM-DD", unitCode, propertyName, status, nights, monthlyRent, ezeeReservationNo), ' +
        'issues (status "open"/"done", title, unit, property, tags, raisedBy, lastBy, createdAt, updatedAt), offlineInquiries (tenant leads: status new/interested/considering/uninterested/booked, lookingFor, budget, assignedTo, updatedAt), ' +
        'offlinePayments (status Checked/Pending/Unknown/Edited, amount, date, unitCode, propertyName), properties (name, code, state), units (unitCode, propertyId), owners, tenants. ' +
        '"where" = exact Firestore filters (text dates compare as text). "dateFilter" = whole-day date checks in Malaysia time on any date field, e.g. ' +
        '{"field":"updatedAt","check":"moreThanDaysAgo","days":3} or {"field":"arrival","check":"isTomorrow"}. Checks: ' + DATE_CHECKS.join(', ') + '. ' +
        '"countOnly": true returns just the number. "fields" picks which fields to return (keeps answers short).',
      input:
        '{ "collection": "issues", "where": [{ "field": "status", "op": "==", "value": "open" }], "dateFilter": { "field": "createdAt", "check": "moreThanDaysAgo", "days": 3 }, "fields": ["title", "unit", "property", "createdAt"], "orderBy": "createdAt", "direction": "asc", "limit": 30, "countOnly": false }',
      label: (i) => `Reading PMS: ${i?.collection ?? ''}${i?.dateFilter ? ' (date check)' : ''}`,
      async run(input) {
        const collection = String(input?.collection ?? '');
        const where = (Array.isArray(input?.where) ? input.where : []).slice(0, 5).map((w: any) => {
          if (!OPS.includes(w?.op)) throw new Error(`Unknown filter operator ${w?.op}. Use one of ${OPS.join(' ')}`);
          return { field: String(w.field), op: w.op as FirestoreOp, value: w.value };
        });
        const df = input?.dateFilter && typeof input.dateFilter === 'object' ? input.dateFilter : null;
        if (df && !DATE_CHECKS.includes(df.check)) throw new Error(`Unknown date check ${df.check}. Use one of ${DATE_CHECKS.join(', ')}`);
        const limit = Math.min(50, Math.max(1, Number(input?.limit ?? 30)));
        // With a date check or a count, read more rows and filter/count here.
        const fetch = df || input?.countOnly ? 500 : limit;
        const orderBy = input?.orderBy ? { field: String(input.orderBy), direction: input.direction === 'desc' ? ('desc' as const) : ('asc' as const) } : undefined;
        let rows = (await (await access()).query(collection, { where, orderBy, limit: fetch })).map((r) => ({ id: r.id, ...r.data }) as Record<string, unknown>);
        if (df) rows = rows.filter((r) => evaluateCondition(r[String(df.field)], df.check, df.days ?? ''));
        const total = rows.length;
        if (input?.countOnly) return { count: total, note: fetch === 500 && total === 500 ? 'At least 500 (only the first 500 were checked).' : undefined };
        const fields: string[] | null = Array.isArray(input?.fields) && input.fields.length ? input.fields.map(String) : null;
        const shown = rows.slice(0, limit).map((r) => (fields ? Object.fromEntries([['id', r.id], ...fields.map((f) => [f, r[f]])]) : r));
        return { count: total, shown: shown.length, rows: shown, ...(total > shown.length ? { note: `Showing ${shown.length} of ${total}. Use a narrower filter or countOnly for totals.` } : {}) };
      },
    },
    {
      name: 'pms_get',
      description: 'Read one PMS document by its path, e.g. "issues/IS-0042" or "properties/P-001".',
      input: '{ "path": "collection/documentId" }',
      label: (i) => `Reading PMS: ${i?.path ?? ''}`,
      async run(input) {
        const doc = await (await access()).get(String(input?.path ?? ''));
        return doc ? { id: doc.id, ...doc.data } : 'Not found.';
      },
    },
  ];
}
