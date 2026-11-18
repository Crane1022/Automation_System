import type { DailyRunStats } from './system.js';

/**
 * AI Performance: how much each AI employee works, how well, and what it costs.
 * Tokens are counted from every AI call. Cost is only shown for models an Admin has
 * given a price (prices change often, so none are built in — no guessed numbers).
 */

/** Price of one model in US dollars per 1 million tokens. */
export interface ModelPrice {
  /** Model name, or the start of it ("gpt-4o-mini" also matches "gpt-4o-mini-2024-07-18"). */
  model: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

/** One day × AI employee × model, counted as calls happen. */
export interface UsageRow {
  day: string;
  agentId: string;
  agentName: string;
  department: string | null;
  model: string;
  calls: number;
  chatCalls: number;
  taskCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentPerformance {
  agentId: string;
  name: string;
  avatar: string;
  color: string;
  department: string | null;
  tasks: number;
  completed: number;
  failed: number;
  cancelled: number;
  waiting: number;
  /** completed ÷ (completed + failed), null when nothing finished. */
  successRate: number | null;
  avgSeconds: number | null;
  calls: number;
  chatCalls: number;
  taskCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** USD; null when none of its models has a price. */
  cost: number | null;
  /** Some of its tokens are on models without a price. */
  costPartial: boolean;
}

export interface PerformanceReport {
  from: string;
  to: string;
  days: number;
  totals: Omit<AgentPerformance, 'agentId' | 'name' | 'avatar' | 'color' | 'department'>;
  /** Tasks per day (done / failed / other) for the chart. */
  daily: DailyRunStats[];
  dailyTokens: { date: string; tokens: number }[];
  agents: AgentPerformance[];
  models: { model: string; calls: number; inputTokens: number; outputTokens: number; cost: number | null }[];
  departments: { department: string; tasks: number; completed: number; failed: number; tokens: number; cost: number | null }[];
  prices: ModelPrice[];
  /** Models used in this period that have no price yet. */
  unpricedModels: string[];
}

/** YYYY-MM-DD in Malaysia time. */
export function myDay(d: Date | string | number = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
}

/** The price that fits a model best (exact, else the longest matching start). */
export function priceFor(model: string, prices: ModelPrice[]): ModelPrice | null {
  const m = model.toLowerCase();
  let best: ModelPrice | null = null;
  for (const p of prices) {
    const k = p.model.toLowerCase().trim();
    if (!k) continue;
    if (m === k) return p;
    if (m.startsWith(k) && (!best || k.length > best.model.length)) best = p;
  }
  return best;
}

export function costOf(model: string, inputTokens: number, outputTokens: number, prices: ModelPrice[]): number | null {
  const p = priceFor(model, prices);
  return p ? (inputTokens * p.inputPerMillion + outputTokens * p.outputPerMillion) / 1_000_000 : null;
}
