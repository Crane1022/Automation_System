<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Activity, CircleDollarSign, Coins, Gauge, Plus, Save, Timer, Trash2, TrendingUp } from '@lucide/vue';
import type { ModelPrice, PerformanceReport } from '@widebed/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AgentAvatar from '@/components/ai/AgentAvatar.vue';
import DailyRunsChart from '@/components/DailyRunsChart.vue';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { toast, toastError } from '@/lib/toast';

/**
 * AI Performance: what each AI employee did, how well, how fast, and what it used.
 * Every number comes from real records (tasks and counted AI calls). Cost only appears
 * for models an Admin gave a price to.
 */
const auth = useAuthStore();
const days = ref(30);
const report = ref<PerformanceReport | null>(null);
const loading = ref(true);
const error = ref('');

async function load() {
  loading.value = !report.value;
  try {
    report.value = await api<PerformanceReport>('/ai-performance', { query: { days: days.value } });
    error.value = '';
    prices.value = report.value.prices.map((p) => ({ ...p }));
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(days, load);

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const num = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 10_000 ? `${Math.round(v / 1000)}k` : v.toLocaleString());
const usd = (v: number | null, partial = false) => (v === null ? '—' : `${partial ? '≥ ' : ''}$${v < 1 ? v.toFixed(v < 0.01 ? 4 : 3) : v.toFixed(2)}`);
const secs = (s: number | null) => (s === null ? '—' : s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);

const tiles = computed(() => {
  const t = report.value?.totals;
  if (!t) return [];
  return [
    { label: 'Tasks done', value: t.completed.toLocaleString(), sub: `of ${t.tasks} tasks · ${t.failed} failed`, icon: Activity },
    { label: 'Success rate', value: pct(t.successRate), sub: 'done ÷ (done + failed)', icon: Gauge, bar: t.successRate },
    { label: 'Average time', value: secs(t.avgSeconds), sub: 'per finished task', icon: Timer },
    { label: 'AI calls · tokens', value: num(t.inputTokens + t.outputTokens), sub: `${t.calls.toLocaleString()} calls (${t.chatCalls} in chats)`, icon: Coins },
    { label: 'Estimated cost', value: usd(t.cost, t.costPartial), sub: t.costPartial ? 'some models have no price yet' : t.cost === null ? 'set model prices below' : 'from your model prices (USD)', icon: CircleDollarSign },
  ];
});
const maxTokens = computed(() => Math.max(1, ...(report.value?.agents ?? []).map((a) => a.inputTokens + a.outputTokens)));
const empty = computed(() => !!report.value && !report.value.totals.tasks && !report.value.totals.calls);

/* --------------------------------------------------------------- prices (Admin) */
const canPrice = computed(() => auth.can('agent.manage'));
const prices = ref<ModelPrice[]>([]);
const savingPrices = ref(false);
function addPrice(model = '') {
  prices.value.push({ model, inputPerMillion: 0, outputPerMillion: 0 });
}
async function savePrices() {
  savingPrices.value = true;
  try {
    await api('/ai-performance/prices', { method: 'PUT', body: { prices: prices.value.filter((p) => p.model.trim()) } });
    toast('Prices saved', 'success');
    await load();
  } catch (err) {
    toastError(err);
  } finally {
    savingPrices.value = false;
  }
}
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1180px] mx-auto">
    <PageHeader title="AI Performance" subtitle="How much each AI employee works, how often it succeeds, how long it takes and what it uses. Real records only." guide="aiPerformance">
      <div class="flex rounded-lg border border-line p-0.5 bg-surface">
        <button v-for="d in [1, 7, 30, 90]" :key="d" class="h-7 px-2.5 rounded-md text-[12.5px]" :class="days === d ? 'bg-brand-soft text-brand font-medium' : 'text-muted hover:text-ink'" @click="days = d">
          {{ d === 1 ? 'Today' : `${d} days` }}
        </button>
      </div>
    </PageHeader>

    <p v-if="error" class="card p-4 text-bad text-[13px] mb-6">{{ error }}</p>
    <Skeleton v-else-if="loading" kind="tiles" :rows="5" class="mb-4" />

    <template v-else-if="report">
      <div v-if="empty" class="card mb-4">
        <EmptyState :icon="TrendingUp" title="Nothing yet in this period" text="Numbers appear as soon as AI staff answer chats or run tasks. Usage counting started with this update, so older chats are not included." />
      </div>

      <!-- headline numbers -->
      <div class="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
        <div v-for="(t, i) in tiles" :key="t.label" class="card p-4 animate-in" :style="{ '--i': i }">
          <div class="flex items-center justify-between text-muted text-[12px] font-medium">{{ t.label }}<component :is="t.icon" class="size-4 text-subtle" /></div>
          <div class="text-[24px] font-semibold tracking-tight mt-1.5 tabular-nums">{{ t.value }}</div>
          <div v-if="t.bar !== undefined && t.bar !== null" class="h-1.5 rounded-full bg-bad-soft mt-2 overflow-hidden"><div class="h-full bg-ok rounded-full transition-[width] duration-700" :style="{ width: `${Math.round(t.bar * 100)}%` }" /></div>
          <div class="text-[11.5px] text-subtle mt-1">{{ t.sub }}</div>
        </div>
      </div>

      <DailyRunsChart :days="report.daily" title="AI tasks per day" class="mb-4 animate-in" />

      <!-- per AI employee -->
      <section class="card mb-4 animate-in overflow-hidden">
        <h2 class="section-title px-4 pt-4 pb-2">By AI employee</h2>
        <div class="overflow-x-auto">
          <table class="w-full text-[13px]">
            <thead class="text-left text-[11.5px] text-subtle uppercase tracking-wide">
              <tr class="border-b border-line">
                <th class="px-4 py-2 font-medium">AI employee</th>
                <th class="px-3 py-2 font-medium text-right">Tasks</th>
                <th class="px-3 py-2 font-medium">Success</th>
                <th class="px-3 py-2 font-medium text-right">Avg time</th>
                <th class="px-3 py-2 font-medium text-right">AI calls</th>
                <th class="px-3 py-2 font-medium">Tokens</th>
                <th class="px-4 py-2 font-medium text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in report.agents" :key="a.agentId" class="border-b border-line last:border-0 hover:bg-surface-2/60">
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-2.5 min-w-[180px]">
                    <AgentAvatar :avatar="a.avatar" :color="a.color" :size="28" />
                    <div class="min-w-0">
                      <div class="font-medium truncate">{{ a.name }}</div>
                      <div class="text-[11.5px] text-subtle">{{ a.department ?? 'No department' }}</div>
                    </div>
                  </div>
                </td>
                <td class="px-3 py-2.5 text-right tabular-nums" :title="`${a.completed} done · ${a.failed} failed · ${a.cancelled} stopped · ${a.waiting} waiting`">{{ a.tasks }}</td>
                <td class="px-3 py-2.5">
                  <div class="flex items-center gap-2 min-w-[110px]">
                    <div class="h-1.5 w-16 rounded-full bg-bad-soft overflow-hidden" :class="{ 'bg-surface-2': a.successRate === null }">
                      <div v-if="a.successRate !== null" class="h-full bg-ok rounded-full" :style="{ width: `${Math.round(a.successRate * 100)}%` }" />
                    </div>
                    <span class="tabular-nums text-[12.5px]">{{ pct(a.successRate) }}</span>
                  </div>
                </td>
                <td class="px-3 py-2.5 text-right tabular-nums">{{ secs(a.avgSeconds) }}</td>
                <td class="px-3 py-2.5 text-right tabular-nums" :title="`${a.chatCalls} in chats · ${a.taskCalls} in tasks`">{{ a.calls.toLocaleString() }}</td>
                <td class="px-3 py-2.5">
                  <div class="flex items-center gap-2 min-w-[130px]" :title="`${a.inputTokens.toLocaleString()} in · ${a.outputTokens.toLocaleString()} out`">
                    <div class="h-1.5 w-20 rounded-full bg-surface-2 overflow-hidden"><div class="h-full bg-brand rounded-full" :style="{ width: `${((a.inputTokens + a.outputTokens) / maxTokens) * 100}%` }" /></div>
                    <span class="tabular-nums text-[12.5px]">{{ num(a.inputTokens + a.outputTokens) }}</span>
                  </div>
                </td>
                <td class="px-4 py-2.5 text-right tabular-nums">{{ usd(a.cost, a.costPartial) }}</td>
              </tr>
              <tr v-if="!report.agents.length"><td colspan="7" class="px-4 py-6 text-center text-subtle">No AI activity in this period.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <div class="grid lg:grid-cols-2 gap-4">
        <!-- departments -->
        <section class="card p-4 animate-in">
          <h2 class="section-title mb-2">By department</h2>
          <table class="w-full text-[13px]">
            <thead class="text-left text-[11.5px] text-subtle uppercase tracking-wide">
              <tr class="border-b border-line"><th class="py-1.5 font-medium">Department</th><th class="py-1.5 font-medium text-right">Tasks</th><th class="py-1.5 font-medium text-right">Failed</th><th class="py-1.5 font-medium text-right">Tokens</th><th class="py-1.5 font-medium text-right">Cost</th></tr>
            </thead>
            <tbody>
              <tr v-for="d in report.departments" :key="d.department" class="border-b border-line last:border-0">
                <td class="py-2">{{ d.department }}</td>
                <td class="py-2 text-right tabular-nums">{{ d.tasks }}</td>
                <td class="py-2 text-right tabular-nums" :class="d.failed ? 'text-bad' : ''">{{ d.failed }}</td>
                <td class="py-2 text-right tabular-nums">{{ num(d.tokens) }}</td>
                <td class="py-2 text-right tabular-nums">{{ usd(d.cost) }}</td>
              </tr>
              <tr v-if="!report.departments.length"><td colspan="5" class="py-4 text-center text-subtle">—</td></tr>
            </tbody>
          </table>
        </section>

        <!-- models + prices -->
        <section class="card p-4 animate-in">
          <h2 class="section-title mb-2">By AI model</h2>
          <table class="w-full text-[13px]">
            <thead class="text-left text-[11.5px] text-subtle uppercase tracking-wide">
              <tr class="border-b border-line"><th class="py-1.5 font-medium">Model</th><th class="py-1.5 font-medium text-right">Calls</th><th class="py-1.5 font-medium text-right">Tokens in / out</th><th class="py-1.5 font-medium text-right">Cost</th></tr>
            </thead>
            <tbody>
              <tr v-for="m in report.models" :key="m.model" class="border-b border-line last:border-0">
                <td class="py-2 font-mono text-[12px] break-all">{{ m.model }}</td>
                <td class="py-2 text-right tabular-nums">{{ m.calls }}</td>
                <td class="py-2 text-right tabular-nums">{{ num(m.inputTokens) }} / {{ num(m.outputTokens) }}</td>
                <td class="py-2 text-right tabular-nums">{{ usd(m.cost) }}</td>
              </tr>
              <tr v-if="!report.models.length"><td colspan="4" class="py-4 text-center text-subtle">—</td></tr>
            </tbody>
          </table>

          <details v-if="canPrice" class="mt-4 rounded-lg bg-surface-2 p-3" :open="report.unpricedModels.length > 0">
            <summary class="cursor-pointer text-[13px] font-medium">Model prices (for the cost estimate)</summary>
            <p class="text-[12px] text-muted mt-1.5">
              In US dollars per 1 million tokens, from your AI provider’s price page. A name also covers longer versions (“gpt-4o-mini” covers “gpt-4o-mini-2024-07-18”). No price = no cost shown.
            </p>
            <div v-if="report.unpricedModels.length" class="mt-2 flex flex-wrap gap-1.5 text-[12px]">
              <span class="text-warn">Used without a price:</span>
              <button v-for="m in report.unpricedModels.filter((x) => !prices.some((p) => p.model === x))" :key="m" class="chip h-6 font-mono" @click="addPrice(m)"><Plus class="size-3" />{{ m }}</button>
            </div>
            <div class="mt-3 space-y-2">
              <div class="grid grid-cols-[1fr_90px_90px_32px] gap-2 text-[11.5px] text-subtle"><span>Model</span><span>Input $/1M</span><span>Output $/1M</span><span /></div>
              <div v-for="(p, i) in prices" :key="i" class="grid grid-cols-[1fr_90px_90px_32px] gap-2">
                <input v-model="p.model" class="input h-8 font-mono text-[12px]" placeholder="e.g. gemini-2.5-flash" maxlength="120" />
                <input v-model.number="p.inputPerMillion" type="number" min="0" step="0.01" class="input h-8 tabular-nums" aria-label="Input price per million tokens" />
                <input v-model.number="p.outputPerMillion" type="number" min="0" step="0.01" class="input h-8 tabular-nums" aria-label="Output price per million tokens" />
                <button class="btn-ghost btn-icon" aria-label="Remove price" @click="prices.splice(i, 1)"><Trash2 class="size-3.5" /></button>
              </div>
              <div class="flex gap-2">
                <button class="btn-secondary h-8" @click="addPrice()"><Plus class="size-3.5" />Add model</button>
                <button class="btn-primary h-8 ml-auto" :disabled="savingPrices" @click="savePrices"><Save class="size-3.5" />Save prices</button>
              </div>
            </div>
          </details>
        </section>
      </div>
      <p class="text-[11.5px] text-subtle mt-4">
        {{ report.from }} – {{ report.to }} (Malaysia time). Tasks include scheduled, given and team-work parts. AI calls include chats. Cost is an estimate from the prices above; your AI provider’s bill is the real amount.
      </p>
    </template>
  </div>
</template>
