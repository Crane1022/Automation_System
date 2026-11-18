<script setup lang="ts">
import { ChevronDown, ExternalLink, Square } from '@lucide/vue';
import type { Execution, ExecutionStep } from '@widebed/shared';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { formatDuration } from '@/lib/format';

defineProps<{ execution: Execution | null; steps: ExecutionStep[]; selectedNodeId: string | null; error?: string | null }>();
const emit = defineEmits<{ select: [nodeId: string]; close: []; cancel: [] }>();
</script>

<template>
  <section class="animate-in h-[220px] shrink-0 border-t border-line bg-surface flex flex-col">
    <header class="h-10 flex items-center gap-3 px-3 border-b border-line">
      <span class="section-title">Execution</span>
      <template v-if="execution">
        <StatusBadge :status="execution.status" />
        <span class="text-[12px] text-muted tabular-nums">{{ formatDuration(execution.duration) }}</span>
        <span v-if="execution.errorSummary" class="text-[12px] text-bad truncate max-w-[480px]">{{ execution.errorSummary }}</span>
        <button v-if="['queued', 'running'].includes(execution.status)" class="btn-secondary h-7 text-[12px]" @click="emit('cancel')"><Square class="size-3" />Stop</button>
        <RouterLink :to="`/executions/${execution.executionId}`" class="ml-auto text-[12px] text-brand inline-flex items-center gap-1 hover:underline">
          Open details<ExternalLink class="size-3" />
        </RouterLink>
      </template>
      <button class="btn-ghost btn-icon" :class="{ 'ml-auto': !execution }" aria-label="Hide panel" @click="emit('close')"><ChevronDown class="size-4" /></button>
    </header>
    <div class="flex-1 overflow-y-auto">
      <div v-if="error" class="m-3 rounded-md bg-bad-soft text-bad text-[13px] p-3">
        <b>The run could not start.</b> {{ error }}
        <span v-if="/Redis/.test(error)" class="block text-[12px] mt-1 text-ink/70">
          Start Redis (Docker Desktop → <code>docker start widebed-redis</code>), or remove <code>REDIS_URL</code> from <code>apps/api/.env</code> and restart the API to run without Redis.
        </span>
      </div>
      <p v-else-if="!steps.length" class="p-4 text-[13px] text-muted flex items-center gap-2"><span class="dots text-brand"><span /><span /><span /></span>Waiting for the first node…</p>
      <table v-else class="w-full">
        <tbody>
          <tr
            v-for="s in steps"
            :key="s.stepId"
            class="animate-in cursor-pointer hover:bg-surface-2 transition-colors"
            :class="{ 'bg-brand-soft/60': s.nodeId === selectedNodeId }"
            @click="emit('select', s.nodeId)"
          >
            <td class="px-3 py-1.5 text-[13px] font-medium w-1/3">{{ s.nodeName }}</td>
            <td class="px-3 py-1.5"><StatusBadge :status="s.status" /></td>
            <td class="px-3 py-1.5 text-[12px] text-muted tabular-nums">{{ formatDuration(s.duration) }}</td>
            <td class="px-3 py-1.5 text-[12px] text-muted">{{ s.attempt > 1 ? `${s.attempt} attempts` : '' }}</td>
            <td class="px-3 py-1.5 text-[12px] text-bad truncate max-w-[360px]">{{ s.error?.message }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
