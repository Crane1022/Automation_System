<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ArrowRight, Check, CircleX, Clock, Loader2, Network, ShieldQuestion } from '@lucide/vue';
import type { AgentProjectView, AgentSummary } from '@widebed/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AgentAvatar from '@/components/ai/AgentAvatar.vue';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { renderMarkdown } from '@/lib/markdown';
import { toastError } from '@/lib/toast';

/** Agent Collaboration: how a manager split a request between AI staff, and what each one returned. */
const projects = ref<AgentProjectView[]>([]);
const agents = ref<Map<string, AgentSummary>>(new Map());
const loading = ref(true);
const openTask = ref<string | null>(null);

async function load(quiet = false) {
  try {
    const [p, a] = await Promise.all([api<{ items: AgentProjectView[] }>('/agent-projects', { quiet }), agents.value.size ? null : api<{ items: AgentSummary[] }>('/agents', { quiet: true })]);
    projects.value = p.items;
    if (a) agents.value = new Map(a.items.map((x) => [x.agentId, x]));
  } catch (err) {
    if (!quiet) toastError(err);
  } finally {
    loading.value = false;
  }
}
const active = computed(() => projects.value.some((p) => p.status === 'running'));
let timer: ReturnType<typeof setInterval> | null = null;
watch(active, (on) => {
  if (on && !timer) timer = setInterval(() => load(true), 2500);
  if (!on && timer) {
    clearInterval(timer);
    timer = null;
  }
});
onMounted(() => load());
onBeforeUnmount(() => timer && clearInterval(timer));

/** Columns: parts that can start straight away first, then the ones that wait for them. */
function columns(p: AgentProjectView) {
  const level = new Map<string, number>();
  for (const t of p.subtasks) level.set(t.taskId, 1 + Math.max(-1, ...(t.dependsOn ?? []).map((d) => level.get(d) ?? 0)));
  const cols: AgentProjectView['subtasks'][] = [];
  for (const t of p.subtasks) (cols[level.get(t.taskId) ?? 0] ??= []).push(t);
  return cols.filter(Boolean);
}
const nameOf = (p: AgentProjectView, id: string) => p.subtasks.find((t) => t.taskId === id)?.agentName ?? '?';
const STATUS: Record<string, { label: string; cls: string }> = {
  running: { label: 'Working', cls: 'bg-info-soft text-info' },
  done: { label: 'Done', cls: 'bg-ok-soft text-ok' },
  partial: { label: 'Partly done', cls: 'bg-warn-soft text-warn' },
  failed: { label: 'Failed', cls: 'bg-bad-soft text-bad' },
  cancelled: { label: 'Stopped', cls: 'bg-surface-2 text-subtle' },
};
const opened = computed(() => {
  for (const p of projects.value) {
    const t = p.subtasks.find((x) => x.taskId === openTask.value);
    if (t) return t;
  }
  return null;
});
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1180px] mx-auto">
    <PageHeader title="Collaboration" subtitle="When a manager AI splits a request, you see here who did which part, what waited for what, and what each one found." />

    <Skeleton v-if="loading" kind="list" :rows="3" />
    <div v-else-if="!projects.length" class="card">
      <EmptyState :icon="Network" title="No team work yet" text="Ask the Main Manager something that needs several areas, e.g. “Prepare a report about tomorrow’s arrivals and any open issues in those units”." />
    </div>

    <div v-else class="space-y-4">
      <article v-for="(p, pi) in projects" :key="p.projectId" class="card p-4 animate-in" :style="{ '--i': Math.min(pi, 8) }">
        <header class="flex items-start gap-3">
          <AgentAvatar :avatar="p.managerAvatar" :color="p.managerColor" :size="38" :working="p.status === 'running'" />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-semibold text-[14px]">{{ p.managerName }}</span>
              <span class="chip h-5 text-[11px] border-0" :class="STATUS[p.status]?.cls">{{ STATUS[p.status]?.label }}</span>
            </div>
            <p class="text-[12px] text-subtle">For {{ p.requestedForName }} · {{ timeAgo(p.createdAt) }} · {{ p.subtasks.length }} {{ p.subtasks.length === 1 ? 'part' : 'parts' }}</p>
          </div>
          <RouterLink v-if="p.taskId" :to="{ path: '/ai-tasks', query: { task: p.taskId } }" class="text-[12px] text-brand hover:underline shrink-0">Manager’s task</RouterLink>
        </header>

        <!-- The plan: columns from left (start now) to right (waits for earlier parts) -->
        <div class="mt-4 flex items-stretch gap-2 overflow-x-auto pb-1">
          <template v-for="(col, ci) in columns(p)" :key="ci">
            <div v-if="ci > 0" class="flex items-center text-subtle shrink-0"><ArrowRight class="size-4" /></div>
            <div class="flex flex-col gap-2 min-w-[220px] max-w-[260px]">
              <button
                v-for="t in col"
                :key="t.taskId"
                class="text-left rounded-lg border px-3 py-2.5 transition-[border-color,box-shadow] hover:border-brand"
                :class="[openTask === t.taskId ? 'border-brand ring-1 ring-brand' : 'border-line', t.status === 'running' ? 'bg-info-soft/40' : 'bg-surface']"
                @click="openTask = openTask === t.taskId ? null : t.taskId"
              >
                <div class="flex items-center gap-2">
                  <AgentAvatar :avatar="agents.get(t.agentId)?.avatar ?? '🤖'" :color="agents.get(t.agentId)?.color ?? 'slate'" :size="24" :working="t.status === 'running'" />
                  <span class="text-[13px] font-medium truncate flex-1">{{ t.agentName }}</span>
                  <Loader2 v-if="t.status === 'running' || t.status === 'queued'" class="size-3.5 animate-spin text-info" />
                  <Check v-else-if="t.status === 'completed'" class="size-3.5 text-ok" />
                  <ShieldQuestion v-else-if="t.status === 'waiting_approval'" class="size-3.5 text-warn" />
                  <CircleX v-else class="size-3.5 text-bad" />
                </div>
                <p class="text-[12px] text-muted mt-1 line-clamp-2">{{ t.title }}</p>
                <p v-if="t.dependsOn?.length" class="text-[11px] text-subtle mt-1">after {{ t.dependsOn.map((d) => nameOf(p, d)).join(' + ') }}</p>
                <p v-if="t.durationMs" class="text-[11px] text-subtle mt-0.5 flex items-center gap-1"><Clock class="size-3" />{{ Math.max(1, Math.round(t.durationMs / 1000)) }} s</p>
              </button>
            </div>
          </template>
        </div>

        <!-- One part opened -->
        <div v-if="opened && p.subtasks.some((x) => x.taskId === openTask)" class="mt-3 rounded-lg border border-line p-4 text-[13px] animate-in">
          <div class="flex items-center justify-between gap-3 mb-2">
            <span class="font-medium">{{ opened.agentName }} — what it was asked</span>
            <RouterLink :to="{ path: '/ai-tasks', query: { task: opened.taskId } }" class="text-[12px] text-brand hover:underline">Open in AI Tasks</RouterLink>
          </div>
          <p class="whitespace-pre-wrap text-muted text-[12.5px] max-h-[160px] overflow-y-auto">{{ opened.instructions }}</p>
          <template v-if="opened.output">
            <div class="font-medium mt-3 mb-1">What it found</div>
            <div class="md rounded-md bg-surface-2 p-3" v-html="renderMarkdown(opened.output)" />
          </template>
          <p v-if="opened.status === 'waiting_approval'" class="mt-3 rounded-md bg-warn-soft p-2.5">Waiting for approval. <RouterLink v-if="opened.approvalId" :to="{ path: '/ai-approvals', query: { id: opened.approvalId } }" class="text-brand hover:underline">Review</RouterLink></p>
          <p v-if="opened.error" class="mt-3 rounded-md bg-bad-soft text-bad p-2.5">{{ opened.error }}</p>
        </div>
      </article>
    </div>
  </div>
</template>
