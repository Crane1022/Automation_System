import {
  DEFAULT_AGENT_ID,
  costOf,
  hasPermission,
  myDay,
  type AgentPerformance,
  type AppUser,
  type DailyRunStats,
  type ModelPrice,
  type PerformanceReport,
} from '@widebed/shared';
import type { Repositories } from '../repositories/types.js';
import { forbidden } from '../lib/http-error.js';

const PRICES_KEY = 'aiPrices';

/**
 * AI Performance numbers, worked out from real records only:
 *   tasks (aiTasks) → how many, done / failed, how long;
 *   usage (aiUsage) → AI calls and tokens per day, AI employee and model;
 *   cost = tokens × the prices an Admin entered (no price → no cost shown).
 * Admins see everyone; department managers see the AI staff of their own department.
 */
export class PerformanceService {
  constructor(private repos: Repositories) {}

  /** null = may not see the page; '' = everything; otherwise only this department. */
  scope(user: AppUser): string | null {
    if (hasPermission(user, 'agent.manage') || hasPermission(user, 'audit.view')) return '';
    if (user.role === 'department_manager' && user.department) return user.department;
    return null;
  }

  async prices(): Promise<ModelPrice[]> {
    return (await this.repos.settings.get<ModelPrice[]>(PRICES_KEY)) ?? [];
  }

  async setPrices(user: AppUser, prices: ModelPrice[]) {
    if (!hasPermission(user, 'agent.manage')) throw forbidden('Only Admins can set AI prices');
    const clean = prices
      .map((p) => ({ model: p.model.trim().slice(0, 120), inputPerMillion: Math.max(0, p.inputPerMillion), outputPerMillion: Math.max(0, p.outputPerMillion) }))
      .filter((p) => p.model);
    await this.repos.settings.set(PRICES_KEY, clean);
    return clean;
  }

  async report(user: AppUser, days: number, now = new Date()): Promise<PerformanceReport> {
    const scope = this.scope(user);
    if (scope === null) throw forbidden('Only Admins and department managers can see AI performance');
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) dates.push(myDay(now.getTime() - i * 86400_000));
    const from = dates[0]!;
    const to = dates.at(-1)!;
    const inScope = (dept: string | null) => !scope || (dept ?? '').toLowerCase() === scope.toLowerCase();

    const [agentsRaw, usageRaw, tasksRaw, prices] = await Promise.all([this.repos.agents.list(500), this.repos.usage.list(from, to), this.repos.agentTasks.listRecent(5000), this.prices()]);
    const agents = new Map(agentsRaw.map((a) => [a.agentId, a]));
    const usage = usageRaw.filter((u) => inScope(agents.get(u.agentId)?.department ?? u.department));
    const tasks = tasksRaw.filter((t) => myDay(t.createdAt) >= from && myDay(t.createdAt) <= to && inScope(agents.get(t.agentId)?.department ?? t.department));

    const blank = (agentId: string): AgentPerformance => {
      const a = agents.get(agentId);
      return {
        agentId,
        name: a?.name ?? usage.find((u) => u.agentId === agentId)?.agentName ?? tasks.find((t) => t.agentId === agentId)?.agentName ?? (agentId === DEFAULT_AGENT_ID ? 'Widebed Assistant' : 'Removed AI employee'),
        avatar: a?.avatar ?? (agentId === DEFAULT_AGENT_ID ? '✨' : '🤖'),
        color: a?.color ?? 'slate',
        department: a?.department ?? null,
        tasks: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        waiting: 0,
        successRate: null,
        avgSeconds: null,
        calls: 0,
        chatCalls: 0,
        taskCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: null,
        costPartial: false,
      };
    };
    const byAgent = new Map<string, AgentPerformance & { _dur: number[] }>();
    const get = (id: string) => {
      if (!byAgent.has(id)) byAgent.set(id, { ...blank(id), _dur: [] });
      return byAgent.get(id)!;
    };
    const addCost = (x: { cost: number | null; costPartial: boolean }, c: number | null, tokens: number) => {
      if (c === null) {
        if (tokens > 0) x.costPartial = true;
      } else x.cost = (x.cost ?? 0) + c;
    };

    const daily = new Map<string, DailyRunStats>(dates.map((d) => [d, { date: d, success: 0, failed: 0, other: 0 }]));
    for (const t of tasks) {
      const a = get(t.agentId);
      a.tasks++;
      const day = daily.get(myDay(t.createdAt));
      if (t.status === 'completed') {
        a.completed++;
        if (t.durationMs) a._dur.push(t.durationMs);
        if (day) day.success++;
      } else if (t.status === 'failed') {
        a.failed++;
        if (day) day.failed++;
      } else {
        if (t.status === 'cancelled') a.cancelled++;
        else a.waiting++;
        if (day) day.other++;
      }
    }

    const dailyTokens = new Map(dates.map((d) => [d, 0]));
    const models = new Map<string, PerformanceReport['models'][number]>();
    const unpriced = new Set<string>();
    for (const u of usage) {
      const a = get(u.agentId);
      a.calls += u.calls;
      a.chatCalls += u.chatCalls;
      a.taskCalls += u.taskCalls;
      a.inputTokens += u.inputTokens;
      a.outputTokens += u.outputTokens;
      const c = costOf(u.model, u.inputTokens, u.outputTokens, prices);
      addCost(a, c, u.inputTokens + u.outputTokens);
      if (c === null && u.inputTokens + u.outputTokens > 0) unpriced.add(u.model);
      dailyTokens.set(u.day, (dailyTokens.get(u.day) ?? 0) + u.inputTokens + u.outputTokens);
      const m = models.get(u.model) ?? { model: u.model, calls: 0, inputTokens: 0, outputTokens: 0, cost: null };
      m.calls += u.calls;
      m.inputTokens += u.inputTokens;
      m.outputTokens += u.outputTokens;
      if (c !== null) m.cost = (m.cost ?? 0) + c;
      models.set(u.model, m);
    }

    const list = [...byAgent.values()].map(({ _dur, ...a }) => ({
      ...a,
      successRate: a.completed + a.failed ? a.completed / (a.completed + a.failed) : null,
      avgSeconds: _dur.length ? Math.round(_dur.reduce((x, y) => x + y, 0) / _dur.length / 1000) : null,
    }));
    list.sort((a, b) => b.tasks + b.calls - (a.tasks + a.calls) || a.name.localeCompare(b.name));

    const totals = blank('');
    const allDur: number[] = [];
    for (const [, a] of byAgent) allDur.push(...a._dur);
    for (const a of list) {
      for (const k of ['tasks', 'completed', 'failed', 'cancelled', 'waiting', 'calls', 'chatCalls', 'taskCalls', 'inputTokens', 'outputTokens'] as const) totals[k] += a[k];
      if (a.cost !== null) totals.cost = (totals.cost ?? 0) + a.cost;
      if (a.costPartial) totals.costPartial = true;
    }
    totals.successRate = totals.completed + totals.failed ? totals.completed / (totals.completed + totals.failed) : null;
    totals.avgSeconds = allDur.length ? Math.round(allDur.reduce((x, y) => x + y, 0) / allDur.length / 1000) : null;

    const depts = new Map<string, PerformanceReport['departments'][number]>();
    for (const a of list) {
      const key = a.department ?? 'No department';
      const d = depts.get(key) ?? { department: key, tasks: 0, completed: 0, failed: 0, tokens: 0, cost: null };
      d.tasks += a.tasks;
      d.completed += a.completed;
      d.failed += a.failed;
      d.tokens += a.inputTokens + a.outputTokens;
      if (a.cost !== null) d.cost = (d.cost ?? 0) + a.cost;
      depts.set(key, d);
    }

    const { agentId: _i, name: _n, avatar: _a, color: _c, department: _d, ...tot } = totals;
    return {
      from,
      to,
      days,
      totals: tot,
      daily: [...daily.values()],
      dailyTokens: [...dailyTokens.entries()].map(([date, tokens]) => ({ date, tokens })),
      agents: list,
      models: [...models.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
      departments: [...depts.values()].sort((a, b) => b.tasks - a.tasks || b.tokens - a.tokens),
      prices,
      unpricedModels: [...unpriced].sort(),
    };
  }
}
