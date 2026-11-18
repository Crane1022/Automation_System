<script setup lang="ts">
import PageHeader from '@/components/ui/PageHeader.vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft, Pencil, RotateCw, Square } from '@lucide/vue';
import type { Execution, ExecutionStep } from '@widebed/shared';
import { TERMINAL_STATUSES } from '@widebed/shared';
import { api, streamEvents } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';
import { formatDate, formatDuration, triggerLabels } from '@/lib/format';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import JsonView from '@/components/ui/JsonView.vue';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();

const route = useRoute();
const router = useRouter();
const exec = ref<Execution | null>(null);
const steps = ref<ExecutionStep[]>([]);
const selected = ref<string | null>(null);
const error = ref<string | null>(null);
let stop: (() => void) | null = null;

const current = computed(() => steps.value.find((s) => s.stepId === selected.value) ?? steps.value.find((s) => s.status === 'failed') ?? steps.value[0]);
const live = computed(() => exec.value && !TERMINAL_STATUSES.includes(exec.value.status));

function upsert(step: ExecutionStep) {
  const i = steps.value.findIndex((s) => s.stepId === step.stepId);
  if (i === -1) steps.value.push(step);
  else steps.value[i] = step;
}

async function load() {
  try {
    const res = await api<Execution & { steps: ExecutionStep[] }>(`/executions/${route.params.id}`);
    const { steps: s, ...e } = res;
    exec.value = e;
    steps.value = s;
    if (live.value) {
      stop = streamEvents(`/executions/${e.executionId}/stream`, (type, data) => {
        if (type === 'execution.status' && exec.value) Object.assign(exec.value, { status: data.status, errorSummary: data.errorSummary ?? null, duration: data.duration ?? null });
        if (type === 'step.started' || type === 'step.finished') upsert(data.step);
        if (type === 'snapshot') {
          exec.value = data.execution;
          (data.steps as ExecutionStep[]).forEach(upsert);
        }
      });
    }
  } catch (err) {
    error.value = (err as Error).message;
  }
}

async function retry() {
  try {
    const res = await api<{ executionId: string }>(`/executions/${exec.value!.executionId}/retry`, { method: 'POST' });
    toast('Retry started', 'success');
    router.push(`/executions/${res.executionId}`);
  } catch (err) {
    toastError(err);
  }
}
async function cancel() {
  try {
    await api(`/executions/${exec.value!.executionId}/cancel`, { method: 'POST' });
  } catch (err) {
    toastError(err);
  }
}

onMounted(load);
// Same component is reused when moving between executions (e.g. after Retry).
watch(() => route.params.id, () => {
  stop?.();
  selected.value = null;
  exec.value = null;
  steps.value = [];
  load();
});
onBeforeUnmount(() => stop?.());
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1280px] mx-auto">
    <button class="btn-ghost -ml-2 mb-3" @click="router.push('/executions')"><ArrowLeft class="size-4" />Executions</button>
    <p v-if="error" class="card p-4 text-bad text-[13px]">{{ error }}</p>

    <template v-if="exec">
      <PageHeader>
        <template #title>
          <div class="flex items-center gap-2.5">
            <h1 class="page-title">{{ exec.workflowName }}</h1>
            <StatusBadge :status="exec.status" size="md" />
          </div>
          <p class="text-[12px] text-subtle font-mono mt-1">{{ exec.executionId }}</p>
        </template>
        <div class="flex flex-wrap gap-2">
          <RouterLink :to="`/workflows/${exec.workflowId}/edit`" class="btn-secondary"><Pencil class="size-4" />Open workflow</RouterLink>
          <button v-if="live" class="btn-secondary" @click="cancel"><Square class="size-4" />Cancel</button>
          <button v-if="['failed', 'cancelled'].includes(exec.status) && !exec.isTestRun" class="btn-primary" @click="retry"><RotateCw class="size-4" />Retry</button>
        </div>
      </PageHeader>

      <div class="card grid grid-cols-2 md:grid-cols-5 divide-x divide-line mb-4">
        <div class="p-3"><div class="label">Trigger</div><div class="text-[13px]">{{ triggerLabels[exec.triggerType] }}</div></div>
        <div class="p-3"><div class="label">Version</div><div class="text-[13px]">{{ exec.isTestRun ? 'Draft (test run)' : `v${exec.workflowVersion}` }}</div></div>
        <div class="p-3"><div class="label">Started</div><div class="text-[13px]">{{ formatDate(exec.startedAt ?? exec.createdAt) }}</div></div>
        <div class="p-3"><div class="label">Duration</div><div class="text-[13px] tabular-nums">{{ formatDuration(exec.duration) }}</div></div>
        <div class="p-3"><div class="label">Initiated by</div><div class="text-[13px] truncate">{{ exec.initiatedBy === auth.profile?.uid ? 'You' : exec.initiatedBy ?? 'External (webhook)' }}</div></div>
      </div>
      <div v-if="exec.errorSummary" class="rounded-md bg-bad-soft text-bad text-[13px] p-3 mb-4">{{ exec.errorSummary }}</div>
      <div v-if="exec.retryOf" class="text-[12px] text-muted mb-4">Retry of <RouterLink :to="`/executions/${exec.retryOf}`" class="text-brand underline">{{ exec.retryOf }}</RouterLink></div>

      <div class="grid lg:grid-cols-[320px_minmax(0,1fr)] gap-4">
        <div class="card self-start">
          <div class="px-4 h-11 flex items-center border-b border-line section-title">Nodes ({{ steps.length }})</div>
          <ol>
            <li
              v-for="(s, i) in steps"
              :key="s.stepId"
              class="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-0 cursor-pointer"
              :class="current?.stepId === s.stepId ? 'bg-brand-soft/60' : 'hover:bg-surface-2'"
              @click="selected = s.stepId"
            >
              <span class="text-[11px] text-subtle w-4 tabular-nums">{{ i + 1 }}</span>
              <div class="min-w-0 flex-1">
                <div class="text-[13px] font-medium truncate">{{ s.nodeName }}</div>
                <div class="text-[11px] text-subtle">{{ formatDuration(s.duration) }}<template v-if="s.attempt > 1"> · {{ s.attempt }} attempts</template></div>
              </div>
              <StatusBadge :status="s.status" />
            </li>
          </ol>
          <p v-if="!steps.length" class="p-4 text-[13px] text-muted">No node has run yet.</p>
        </div>

        <div v-if="current" class="card p-4 space-y-4 min-w-0">
          <div class="flex items-center gap-2">
            <h2 class="section-title">{{ current.nodeName }}</h2>
            <span class="chip">{{ current.nodeType }}</span>
            <StatusBadge :status="current.status" />
          </div>
          <div v-if="current.error" class="rounded-md bg-bad-soft text-bad text-[13px] p-3">
            <b>{{ current.error.code ?? 'Error' }}</b> — {{ current.error.message }}
            <span v-if="current.error.retryable" class="block text-[12px] mt-1">This error is temporary and can be retried.</span>
          </div>
          <div><h3 class="label">Input</h3><JsonView :value="current.inputData" /></div>
          <div><h3 class="label">Output</h3><JsonView :value="current.outputData" max-height="480px" /></div>
          <p class="text-[11px] text-subtle">Values with secret-looking keys are redacted, and large payloads are truncated before storage.</p>
        </div>
      </div>
    </template>
  </div>
</template>
