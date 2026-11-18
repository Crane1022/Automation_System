<script setup lang="ts">
import Skeleton from '@/components/ui/Skeleton.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Activity, CircleCheck, CircleX, Gauge, Loader, RefreshCw, Workflow } from '@lucide/vue';
import type { Execution } from '@widebed/shared';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { formatDuration, timeAgo, triggerLabels } from '@/lib/format';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import DailyRunsChart from '@/components/DailyRunsChart.vue';
import type { DailyRunStats } from '@widebed/shared';

interface Stats {
  workflows: { total: number; active: number; inactive: number } | null;
  executions: { total: number; success: number; failed: number; successRate: number | null };
  running: { running: number; queued: number };
  recent: Execution[];
}
interface Health {
  status: string;
  uptimeSeconds: number;
  firestore: { ok: boolean; latencyMs?: number; error?: string };
  queue: { mode: string; waiting: number; active: number; concurrency: number };
  memoryMb: number;
}

const auth = useAuthStore();
const router = useRouter();
const range = ref<'1' | '7' | '30' | '90'>('30');
const stats = ref<Stats | null>(null);
const health = ref<Health | null>(null);
const daily = ref<DailyRunStats[] | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

async function load(quiet = false) {
  if (!quiet) loading.value = true;
  error.value = null;
  try {
    const from = new Date(Date.now() - Number(range.value) * 86400_000).toISOString();
    const [s, h] = await Promise.all([api<Stats>('/dashboard/stats', { query: { from }, quiet }), api<Health>('/system/health', { quiet })]);
    stats.value = s;
    health.value = h;
    // The chart is a nice-to-have: if it fails, the rest of the page still shows.
    api<{ days: DailyRunStats[] }>('/dashboard/daily', { query: { days: 14, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }, quiet: true })
      .then((r) => (daily.value = r.days))
      .catch(() => undefined);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

watch(range, () => load());
let timer: number;
onMounted(() => {
  load();
  timer = window.setInterval(() => load(true), 20_000);
});
onBeforeUnmount(() => clearInterval(timer));

const tiles = computed(() => {
  const s = stats.value;
  if (!s) return [];
  return [
    ...(s.workflows
      ? [{ label: 'Workflows', value: s.workflows.total, sub: `${s.workflows.active} active · ${s.workflows.inactive} inactive`, icon: Workflow }]
      : []),
    { label: 'Executions', value: s.executions.total, sub: `in the last ${range.value === '1' ? '24 hours' : range.value + ' days'}`, icon: Activity },
    { label: 'Successful', value: s.executions.success, sub: 'completed without errors', icon: CircleCheck, tone: 'text-ok' },
    { label: 'Failed', value: s.executions.failed, sub: 'need attention', icon: CircleX, tone: s.executions.failed ? 'text-bad' : '' },
  ];
});
const uptime = computed(() => {
  const s = health.value?.uptimeSeconds ?? 0;
  return s > 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
});
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1280px] mx-auto">
    <PageHeader :title="`Good to see you, ${auth.profile?.name?.split(' ')[0] ?? ''}`" subtitle="Here is how your automations are doing.">
      <div class="flex items-center gap-2">
        <div class="flex rounded-md border border-line-strong bg-surface p-0.5">
          <button
            v-for="r in (['1', '7', '30', '90'] as const)"
            :key="r"
            class="h-7 px-2.5 rounded text-[12px] font-medium"
            :class="range === r ? 'bg-brand-soft text-brand' : 'text-muted hover:text-ink'"
            @click="range = r"
          >
            {{ r === '1' ? '24h' : r + 'd' }}
          </button>
        </div>
        <button class="btn-secondary btn-icon" title="Refresh" data-no-loading @click="load()"><RefreshCw class="size-4" :class="{ 'animate-spin': loading }" /></button>
      </div>
    </PageHeader>

    <p v-if="error" class="card p-4 text-bad text-[13px] mb-6">{{ error }}</p>

    <Skeleton v-if="!stats && !error" kind="tiles" :rows="4" class="mb-4" />
    <div v-else class="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
      <div v-for="(t, idx) in tiles" :key="t.label" class="animate-in card p-4" :style="{ '--i': idx }">
        <div class="flex items-center justify-between text-muted text-[12px] font-medium">
          {{ t.label }}<component :is="t.icon" class="size-4 text-subtle" />
        </div>
        <div class="text-[26px] font-semibold tracking-tight mt-1.5 tabular-nums" :class="t.tone">{{ t.value.toLocaleString() }}</div>
        <div class="text-[12px] text-subtle mt-0.5">{{ t.sub }}</div>
      </div>
    </div>

    <DailyRunsChart v-if="daily" :days="daily" class="mb-4 animate-in" />

    <div class="grid lg:grid-cols-3 gap-4 mb-4" v-if="stats">
      <div class="card p-4">
        <div class="flex items-center justify-between text-muted text-[12px] font-medium">Success rate<Gauge class="size-4 text-subtle" /></div>
        <div class="text-[26px] font-semibold tracking-tight mt-1.5 tabular-nums">
          {{ stats.executions.successRate === null ? '—' : stats.executions.successRate + '%' }}
        </div>
        <div class="h-2 rounded-full bg-bad-soft mt-3 overflow-hidden" v-if="stats.executions.successRate !== null">
          <div class="h-full bg-ok rounded-full" :style="{ width: stats.executions.successRate + '%' }" />
        </div>
        <div class="text-[12px] text-subtle mt-2">of finished executions (success ÷ success + failed)</div>
      </div>
      <div class="card p-4">
        <div class="flex items-center justify-between text-muted text-[12px] font-medium">Running jobs<Loader class="size-4 text-subtle" /></div>
        <div class="flex items-baseline gap-4 mt-1.5">
          <div><span class="text-[26px] font-semibold tabular-nums">{{ stats.running.running }}</span> <span class="text-subtle text-[12px]">running</span></div>
          <div><span class="text-[26px] font-semibold tabular-nums">{{ stats.running.queued }}</span> <span class="text-subtle text-[12px]">queued</span></div>
        </div>
        <div v-if="health" class="text-[12px] text-subtle mt-2">
          Worker capacity {{ health.queue.active }}/{{ health.queue.concurrency }} · {{ health.queue.mode }} queue
        </div>
      </div>
      <div class="card p-4">
        <div class="flex items-center justify-between text-muted text-[12px] font-medium">
          System health
          <span v-if="health" class="inline-flex items-center gap-1.5 text-[12px]" :class="health.status === 'ok' ? 'text-ok' : 'text-warn'">
            <span class="size-2 rounded-full bg-current" />{{ health.status === 'ok' ? 'Operational' : 'Degraded' }}
          </span>
        </div>
        <dl v-if="health" class="mt-3 grid grid-cols-2 gap-y-2 text-[13px]">
          <dt class="text-subtle">Firestore</dt>
          <dd class="text-right" :class="health.firestore.ok ? 'text-ok' : 'text-bad'">{{ health.firestore.ok ? `${health.firestore.latencyMs} ms` : 'Unreachable' }}</dd>
          <dt class="text-subtle">API uptime</dt><dd class="text-right">{{ uptime }}</dd>
          <dt class="text-subtle">Memory</dt><dd class="text-right">{{ health.memoryMb }} MB</dd>
        </dl>
      </div>
    </div>

    <div class="card" v-if="stats">
      <div class="flex items-center justify-between px-4 h-12 border-b border-line">
        <h2 class="section-title">Recent activity</h2>
        <RouterLink to="/executions" class="text-[12px] text-brand hover:underline">View all executions</RouterLink>
      </div>
      <EmptyState v-if="!stats.recent.length" :icon="Activity" title="No executions yet" text="Run a workflow from the editor to see it here." />
      <table v-else class="w-full">
        <thead>
          <tr>
            <th class="table-head">Workflow</th>
            <th class="table-head">Status</th>
            <th class="table-head hidden md:table-cell">Trigger</th>
            <th class="table-head hidden md:table-cell">Duration</th>
            <th class="table-head text-right">Started</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in stats.recent" :key="e.executionId" class="hover:bg-surface-2 cursor-pointer" @click="router.push(`/executions/${e.executionId}`)">
            <td class="table-cell font-medium">
              {{ e.workflowName }}
              <span v-if="e.isTestRun" class="chip ml-1.5">test</span>
            </td>
            <td class="table-cell"><StatusBadge :status="e.status" /></td>
            <td class="table-cell hidden md:table-cell text-muted">{{ triggerLabels[e.triggerType] }}</td>
            <td class="table-cell hidden md:table-cell text-muted tabular-nums">{{ formatDuration(e.duration) }}</td>
            <td class="table-cell text-right text-muted">{{ timeAgo(e.createdAt) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
