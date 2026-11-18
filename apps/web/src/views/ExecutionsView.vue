<script setup lang="ts">
import Skeleton from '@/components/ui/Skeleton.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Activity, RefreshCw } from '@lucide/vue';
import type { Execution } from '@widebed/shared';
import { EXECUTION_STATUSES } from '@widebed/shared';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { formatDate, formatDuration, triggerLabels } from '@/lib/format';
import { useAuthStore } from '@/stores/auth';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import EmptyState from '@/components/ui/EmptyState.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const items = ref<Execution[]>([]);
const cursor = ref<string | null>(null);
const loading = ref(false);
const workflows = ref<{ workflowId: string; name: string }[]>([]);

const f = ref({
  workflowId: (route.query.workflowId as string) ?? '',
  status: (route.query.status as string) ?? '',
  triggerType: '',
  department: '',
  from: '',
  to: '',
});

function query(extra: Record<string, unknown> = {}) {
  return {
    workflowId: f.value.workflowId,
    status: f.value.status,
    triggerType: f.value.triggerType,
    department: f.value.department,
    from: f.value.from ? new Date(f.value.from).toISOString() : undefined,
    to: f.value.to ? new Date(f.value.to + 'T23:59:59').toISOString() : undefined,
    limit: 25,
    ...extra,
  };
}

async function load(more = false) {
  loading.value = true;
  try {
    const res = await api<{ items: Execution[]; nextCursor: string | null }>('/executions', { query: query(more && cursor.value ? { cursor: cursor.value } : {}) });
    items.value = more ? [...items.value, ...res.items] : res.items;
    cursor.value = res.nextCursor;
  } catch (err) {
    toastError(err);
  } finally {
    loading.value = false;
  }
}

watch(f, () => load(), { deep: true });
onMounted(async () => {
  load();
  try {
    workflows.value = (await api<{ items: { workflowId: string; name: string }[] }>('/workflows')).items;
  } catch {
    /* filter list is optional */
  }
});
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1280px] mx-auto">
    <PageHeader title="Executions" subtitle="Every workflow run, newest first. Retained for a limited period.">
      <button class="btn-secondary" data-no-loading @click="load()"><RefreshCw class="size-4" :class="{ 'animate-spin': loading }" />Refresh</button>
    </PageHeader>

    <div class="card p-3 mb-4 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
      <select v-model="f.workflowId" class="input"><option value="">All workflows</option><option v-for="w in workflows" :key="w.workflowId" :value="w.workflowId">{{ w.name }}</option></select>
      <select v-model="f.status" class="input"><option value="">All statuses</option><option v-for="s in EXECUTION_STATUSES" :key="s" :value="s">{{ s }}</option></select>
      <select v-model="f.triggerType" class="input"><option value="">All triggers</option><option v-for="(l, k) in triggerLabels" :key="k" :value="k">{{ l }}</option></select>
      <input v-if="auth.can('execution.viewAll')" v-model.lazy="f.department" class="input" placeholder="Department" />
      <input v-model="f.from" type="date" class="input" aria-label="From date" />
      <input v-model="f.to" type="date" class="input" aria-label="To date" />
    </div>

    <div class="card overflow-x-auto">
      <Skeleton v-if="loading && !items.length" kind="table" :rows="8" />
      <EmptyState v-else-if="!loading && !items.length" :icon="Activity" title="No executions match" text="Try different filters, or run a workflow." />
      <table v-else class="w-full min-w-[820px]">
        <thead>
          <tr>
            <th class="table-head">Execution ID</th>
            <th class="table-head">Workflow</th>
            <th class="table-head">Trigger</th>
            <th class="table-head">Started</th>
            <th class="table-head">Duration</th>
            <th class="table-head">Status</th>
            <th class="table-head">Initiated by</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(e, idx) in items" :key="e.executionId" :style="{ '--i': idx }" class="animate-in hover:bg-surface-2 transition-colors cursor-pointer" @click="router.push(`/executions/${e.executionId}`)">
            <td class="table-cell font-mono text-[12px] text-muted">{{ e.executionId }}</td>
            <td class="table-cell font-medium">
              {{ e.workflowName }}
              <span v-if="e.isTestRun" class="chip ml-1">test</span>
              <span v-else-if="e.workflowVersion" class="chip ml-1">v{{ e.workflowVersion }}</span>
            </td>
            <td class="table-cell text-muted">{{ triggerLabels[e.triggerType] }}</td>
            <td class="table-cell text-muted">{{ formatDate(e.startedAt ?? e.createdAt) }}</td>
            <td class="table-cell text-muted tabular-nums">{{ formatDuration(e.duration) }}</td>
            <td class="table-cell"><StatusBadge :status="e.status" /></td>
            <td class="table-cell text-muted text-[12px]">{{ e.initiatedBy === auth.profile?.uid ? 'You' : e.initiatedBy ?? 'External (webhook)' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="cursor" class="p-3 text-center border-t border-line">
        <button class="btn-secondary" :disabled="loading" @click="load(true)">Load more</button>
      </div>
    </div>
  </div>
</template>
