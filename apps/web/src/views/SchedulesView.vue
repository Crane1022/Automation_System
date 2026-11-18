<script setup lang="ts">
import Skeleton from '@/components/ui/Skeleton.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import { onMounted, ref } from 'vue';
import { CalendarClock } from '@lucide/vue';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { formatDate } from '@/lib/format';
import EmptyState from '@/components/ui/EmptyState.vue';

interface Row {
  workflowId: string;
  workflowName: string;
  department: string | null;
  nodeName: string;
  description: string;
  timezone: string;
  nextRunAt: string | null;
}
const items = ref<Row[]>([]);
const mode = ref('');
const loading = ref(true);

onMounted(async () => {
  try {
    const res = await api<{ items: Row[]; mode: string }>('/schedules');
    items.value = res.items;
    mode.value = res.mode;
  } catch (err) {
    toastError(err);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1100px] mx-auto">
    <PageHeader title="Schedules" subtitle="Schedule Triggers of active, published workflows. To add one, put a Schedule Trigger in a workflow, publish it and switch it to Active." />
    <div v-if="mode === 'in-process'" class="rounded-md bg-warn-soft text-warn text-[12px] p-2.5 mb-4">
      Running without Redis: schedules work while this server runs, but use Redis in production so they survive restarts and run only once across servers.
    </div>
    <div class="card overflow-x-auto">
      <Skeleton v-if="loading" kind="table" :rows="4" />
      <EmptyState v-else-if="!items.length" :icon="CalendarClock" title="No active schedules" text="Add a Schedule Trigger to a workflow, publish it and activate it." />
      <table v-else class="w-full min-w-[720px]">
        <thead>
          <tr>
            <th class="table-head">Workflow</th>
            <th class="table-head">Runs</th>
            <th class="table-head">Time zone</th>
            <th class="table-head">Next run</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, idx) in items" :key="r.workflowId + r.nodeName" class="animate-in" :style="{ '--i': idx }">
            <td class="table-cell">
              <RouterLink :to="`/workflows/${r.workflowId}/edit`" class="font-medium hover:text-brand">{{ r.workflowName }}</RouterLink>
              <div class="text-[12px] text-subtle">{{ r.nodeName }}<template v-if="r.department"> · {{ r.department }}</template></div>
            </td>
            <td class="table-cell text-muted">{{ r.description }}</td>
            <td class="table-cell text-muted">{{ r.timezone }}</td>
            <td class="table-cell">
              <template v-if="r.nextRunAt">{{ formatDate(r.nextRunAt) }}</template>
              <span v-else class="text-subtle">Finished (one-time schedule)</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
