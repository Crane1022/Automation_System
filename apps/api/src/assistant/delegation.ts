import { DELEGATION_LIMITS, type AgentProject, type AgentTask, type AiAgent, type AppUser } from '@widebed/shared';
import type { Repositories } from '../repositories/types.js';
import { newId, nowIso } from '../lib/ids.js';
import type { AgentTool } from './agent.js';
import type { AgentRegistry } from './agents.js';

export interface Assignment {
  agent: string;
  task: string;
  /** Numbers (0-based) of earlier assignments this one needs the results of. */
  after?: number[];
}

export interface DelegationDeps {
  repos: Repositories;
  agents: AgentRegistry;
  /** Makes one task record (not queued). */
  newTask: (agent: AiAgent, o: { instructions: string; title: string; runAsId: string; parentTaskId: string | null; projectId: string; dependsOn: string[]; toolLimit: AiAgent['tools'] }) => AgentTask;
  /** Runs one queued task to its end (or until it waits for approval). */
  run: (taskId: string) => Promise<void>;
  /** Stops a running task. */
  stop: (taskId: string) => void;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * The Main Manager's team work.
 *
 * Safety rules (all enforced here, not by the AI):
 * - Helpers are AI staff the PERSON may chat with, switched on, and not managers themselves
 *   (so no loops: helpers can't delegate further — max depth 1).
 * - Each helper works with the person's permissions AND only the tools the manager has
 *   (intersection), so delegating never gives anyone more access.
 * - At most 6 helpers per hand-off, 2 hand-offs per run, 3 working at the same time.
 * - “after” can only point to earlier assignments, so there are no circular waits.
 * - If the manager is stopped, the helpers are stopped too.
 */
export class Delegation {
  constructor(private d: DelegationDeps) {}

  /** Who this manager may hand work to, for this person. */
  async team(user: AppUser, manager: AiAgent) {
    return (await this.d.agents.listFor(user)).filter((a) => a.status === 'active' && a.agentId !== manager.agentId && !a.canDelegate && this.d.agents.canChat(user, a));
  }

  tools(user: AppUser, manager: AiAgent, origin: { chatId: string | null; taskId: string | null }): AgentTool[] {
    let rounds = 0;
    return [
      {
        name: 'list_team',
        description: 'See which AI colleagues you can hand work to: their job, skills and what they can use. Check this before delegating.',
        input: '{}',
        label: () => 'Looking at the team',
        run: async () => {
          const team = await this.team(user, manager);
          if (!team.length) return 'No colleagues are available to this person. Do the work yourself.';
          return team.map((a) => ({
            name: a.name,
            job: a.title,
            department: a.department,
            does: a.description,
            responsibilities: a.responsibilities,
            skills: a.expertise,
            canUse: [a.tools.pms && manager.tools.pms && 'PMS data', a.tools.workflows && manager.tools.workflows && 'workflows', a.tools.browser && manager.tools.browser && 'saved websites'].filter(Boolean),
          }));
        },
      },
      {
        name: 'delegate',
        description:
          'Hand parts of the work to AI colleagues and wait for their results. Independent parts run at the same time. Use "after" to make a part wait for earlier parts (it then gets their results). Give each part complete, specific instructions. Afterwards, check the results against each other and write ONE combined answer. You can delegate at most twice per request (e.g. once more to retry a failed part).',
        input: '{ "assignments": [ { "agent": "PMS Assistant", "task": "List tomorrow\'s arrivals with unit and time" }, { "agent": "Operations Assistant", "task": "List open issues for these units", "after": [0] } ] }',
        label: (i) => {
          const list = Array.isArray(i?.assignments) ? i.assignments : [];
          return `Handing work to ${[...new Set(list.map((x: any) => String(x?.agent ?? '')))].filter(Boolean).join(', ') || 'the team'}`;
        },
        run: async (input, ctx) => {
          if (rounds >= DELEGATION_LIMITS.maxRounds) throw new Error(`You already delegated ${DELEGATION_LIMITS.maxRounds} times for this request. Finish with what you have.`);
          // A hand-off only counts once it is valid and starts.
          return this.delegate(user, manager, origin, input?.assignments, ctx.signal, ctx.progress, () => rounds++);
        },
      },
    ];
  }

  async delegate(user: AppUser, manager: AiAgent, origin: { chatId: string | null; taskId: string | null }, raw: unknown, signal: AbortSignal, progress: (s: string) => void, onStart: () => void = () => undefined) {
    if (!Array.isArray(raw) || !raw.length) throw new Error('Give at least one assignment: { "assignments": [ { "agent": "...", "task": "..." } ] }');
    if (raw.length > DELEGATION_LIMITS.maxSubtasks) throw new Error(`At most ${DELEGATION_LIMITS.maxSubtasks} assignments at once.`);
    const team = await this.team(user, manager);
    const find = (name: string) => team.find((a) => a.agentId === name || a.name.toLowerCase() === name.trim().toLowerCase());
    const list: Assignment[] = raw.map((x: any, i: number) => {
      const agentName = String(x?.agent ?? '');
      const task = String(x?.task ?? '').trim();
      if (!task) throw new Error(`Assignment ${i} has no task.`);
      if (!find(agentName)) throw new Error(`“${agentName}” is not an available colleague. Use list_team to see who you can ask.`);
      const after = Array.isArray(x?.after) ? x.after.map(Number) : [];
      if (after.some((n: number) => !Number.isInteger(n) || n < 0 || n >= i)) throw new Error(`Assignment ${i}: "after" may only list earlier assignments (0 to ${i - 1}).`);
      return { agent: agentName, task, after };
    });

    onStart();
    // The shared project everyone works in.
    const projectId = newId('proj');
    const tasks: AgentTask[] = list.map((a) =>
      this.d.newTask(find(a.agent)!, {
        instructions: `${a.task}\n\n(You were asked by ${manager.name}, who is coordinating this for ${user.name}. Be complete and precise: your result goes back to ${manager.name}.)`,
        title: clip(a.task.replace(/\s+/g, ' '), 100),
        runAsId: user.uid,
        parentTaskId: origin.taskId,
        projectId,
        dependsOn: [],
        toolLimit: manager.tools,
      }),
    );
    tasks.forEach((t, i) => (t.dependsOn = (list[i]!.after ?? []).map((n) => tasks[n]!.taskId)));
    const project: AgentProject = {
      projectId,
      managerAgentId: manager.agentId,
      managerName: manager.name,
      requestedFor: user.uid,
      request: clip(list.map((a) => `${a.agent}: ${a.task}`).join(' · '), 300),
      chatId: origin.chatId,
      taskId: origin.taskId,
      subtaskIds: tasks.map((t) => t.taskId),
      status: 'running',
      createdAt: nowIso(),
      completedAt: null,
    };
    await this.d.repos.projects.create(project);
    for (const t of tasks) await this.d.repos.agentTasks.create(t);

    // Run: start whatever is ready, up to 3 at a time; give each part the results it waits for.
    const state = new Map<string, 'waiting' | 'running' | 'finished'>(tasks.map((t) => [t.taskId, 'waiting']));
    const running = new Map<string, Promise<void>>();
    const onAbort = () => tasks.forEach((t) => state.get(t.taskId) === 'running' && this.d.stop(t.taskId));
    signal.addEventListener('abort', onAbort);
    const finishedCount = () => [...state.values()].filter((s) => s === 'finished').length;
    try {
      while (finishedCount() < tasks.length) {
        if (signal.aborted) {
          for (const t of tasks) if (state.get(t.taskId) === 'waiting') await this.d.repos.agentTasks.update(t.taskId, { status: 'cancelled', error: `${manager.name} was stopped`, completedAt: nowIso() });
          break;
        }
        for (const t of tasks) {
          if (state.get(t.taskId) !== 'waiting' || running.size >= DELEGATION_LIMITS.parallel) continue;
          const deps = t.dependsOn ?? [];
          if (!deps.every((id) => state.get(id) === 'finished')) continue;
          const depTasks = await Promise.all(deps.map((id) => this.d.repos.agentTasks.get(id)));
          const broken = depTasks.find((x) => x && x.status !== 'completed');
          if (broken) {
            await this.d.repos.agentTasks.update(t.taskId, { status: 'cancelled', error: `Skipped: it needed the result of “${broken.title}” (${broken.agentName}), which did not finish.`, completedAt: nowIso() });
            state.set(t.taskId, 'finished');
            continue;
          }
          if (depTasks.length) {
            const handoff = depTasks.map((x) => `### From ${x!.agentName} — “${x!.title}”\n${clip(x!.output ?? '', 4000)}`).join('\n\n');
            await this.d.repos.agentTasks.update(t.taskId, { instructions: `${t.instructions}\n\nResults from your colleagues to build on:\n${handoff}` });
          }
          state.set(t.taskId, 'running');
          progress(`${t.agentName} started`);
          running.set(
            t.taskId,
            this.d
              .run(t.taskId)
              .catch(() => undefined)
              .finally(async () => {
                running.delete(t.taskId);
                state.set(t.taskId, 'finished');
                const after = await this.d.repos.agentTasks.get(t.taskId);
                progress(`${t.agentName} ${after?.status === 'completed' ? 'finished' : after?.status === 'waiting_approval' ? 'is waiting for approval' : 'could not finish'} (${finishedCount()}/${tasks.length})`);
              }),
          );
        }
        if (running.size) await Promise.race(running.values());
        else if (finishedCount() < tasks.length && !signal.aborted) break; // nothing can start (should not happen)
      }
      await Promise.all(running.values());
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    const results = await Promise.all(tasks.map((t) => this.d.repos.agentTasks.get(t.taskId)));
    const ok = results.filter((r) => r?.status === 'completed').length;
    await this.d.repos.projects.update(projectId, {
      status: signal.aborted ? 'cancelled' : ok === results.length ? 'done' : ok ? 'partial' : 'failed',
      completedAt: nowIso(),
    });
    // What the manager reads (untrusted content from colleagues is clearly marked as results).
    return results.map((r, i) => ({
      part: i,
      colleague: r?.agentName,
      task: list[i]!.task,
      status:
        r?.status === 'completed'
          ? 'done'
          : r?.status === 'waiting_approval'
            ? 'waiting for a person to approve a step — tell the person to check the Approvals page; the result is not available yet'
            : `not done: ${r?.error ?? r?.status}`,
      result: r?.status === 'completed' ? clip(r.output ?? '', 6000) : null,
    }));
  }
}
