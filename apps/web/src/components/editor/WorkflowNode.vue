<script setup lang="ts">
import { computed } from 'vue';
import { Handle, Position, type NodeProps } from '@vue-flow/core';
import { AlertTriangle, Ban, CircleCheck, CircleX, Loader2, MinusCircle, RotateCw } from '@lucide/vue';
import { useNodeTypesStore } from '@/stores/nodeTypes';
import { describeSchedule, resolveOutputs, type ScheduleSettings } from '@widebed/shared';
import NodeIcon from '@/components/ui/NodeIcon.vue';
import type { WbNodeData } from './types';

const props = defineProps<NodeProps<WbNodeData>>();
const store = useNodeTypesStore();
const desc = computed(() => store.get(props.data.nodeType));
const outputs = computed(() => (desc.value ? resolveOutputs(desc.value, props.data.config) : [{ id: 'main' }]));
const inputs = computed(() => desc.value?.inputs ?? []);
const exec = computed(() => props.data.exec);
const hasIssues = computed(() => (props.data.issues?.length ?? 0) > 0);
const isPlaceholder = computed(() => props.data.nodeType === 'util.unsupported');
const subtitle = computed(() => {
  if (isPlaceholder.value) return `Needs replacing · ${String(props.data.config.originalType ?? '').replace('n8n-nodes-base.', 'n8n ')}`;
  if (props.data.nodeType === 'trigger.schedule' && desc.value) {
    const defaults = Object.fromEntries(desc.value.fields.map((f) => [f.key, f.default]));
    return describeSchedule({ ...defaults, ...props.data.config } as unknown as ScheduleSettings);
  }
  return desc.value?.displayName ?? props.data.nodeType;
});

const ring = computed(() => {
  switch (exec.value?.status) {
    case 'success': return 'border-ok';
    case 'failed': return 'border-bad';
    case 'running': return 'border-info';
    default: return hasIssues.value ? 'border-warn/60' : 'border-line-strong';
  }
});
// Spread multiple output handles vertically.
const handleTop = (i: number, n: number) => `${((i + 1) / (n + 1)) * 100}%`;
</script>

<template>
  <div
    class="wb-node relative w-[220px] bg-surface rounded-lg border-[1.5px] shadow-[var(--shadow-card)] transition-[border-color,box-shadow,transform] duration-200 hover:shadow-[var(--shadow-pop)]"
    :class="[ring, data.disabled ? 'opacity-55' : '', isPlaceholder ? 'border-dashed !border-bad/60 bg-surface-2' : '', exec?.status === 'running' ? 'wb-node-running' : '', exec?.status === 'success' ? 'wb-node-done' : '']"
  >
    <!-- Inputs -->
    <Handle
      v-for="(h, i) in inputs"
      :id="h.id"
      :key="'in-' + h.id"
      type="target"
      :position="Position.Left"
      :style="{ top: handleTop(i, inputs.length) }"
      class="!size-3 !bg-surface !border-[1.5px] !border-line-strong hover:!border-brand"
    />
    <template v-if="inputs.length > 1">
      <span
        v-for="(h, i) in inputs"
        :key="'inl-' + h.id"
        class="absolute left-[-6px] -translate-x-full -translate-y-1/2 pr-2 text-[10px] font-medium text-muted pointer-events-none whitespace-nowrap"
        :style="{ top: handleTop(i, inputs.length) }"
      >{{ h.label }}</span>
    </template>

    <div class="flex items-center gap-2.5 p-2.5">
      <NodeIcon v-if="desc" :icon="desc.icon" :category="desc.category" size="md" />
      <div class="min-w-0 flex-1">
        <div class="text-[13px] font-medium text-ink truncate leading-tight">{{ data.name }}</div>
        <div class="text-[11px] truncate" :class="isPlaceholder ? 'text-bad' : 'text-subtle'">{{ subtitle }}</div>
      </div>
      <!-- Status -->
      <span class="shrink-0" :title="exec?.error ?? data.issues?.join('\n') ?? ''">
        <Loader2 v-if="exec?.status === 'running'" class="size-4 text-info animate-spin" />
        <CircleCheck v-else-if="exec?.status === 'success'" class="size-4 text-ok" />
        <CircleX v-else-if="exec?.status === 'failed'" class="size-4 text-bad" />
        <MinusCircle v-else-if="exec?.status === 'skipped'" class="size-4 text-subtle" />
        <Ban v-else-if="exec?.status === 'cancelled'" class="size-4 text-subtle" />
        <AlertTriangle v-else-if="hasIssues" class="size-4 text-warn" />
      </span>
    </div>

    <div v-if="exec && exec.status !== 'running'" class="flex items-center gap-2 px-2.5 pb-2 -mt-1 text-[11px]">
      <span v-if="exec.items !== undefined" class="text-muted">{{ exec.items }} item{{ exec.items === 1 ? '' : 's' }}</span>
      <span v-if="exec.attempt && exec.attempt > 1" class="inline-flex items-center gap-0.5 text-warn"><RotateCw class="size-3" />{{ exec.attempt }} attempts</span>
      <span v-if="exec.error" class="text-bad truncate">{{ exec.error }}</span>
    </div>
    <div v-else-if="hasIssues && !exec" class="px-2.5 pb-2 -mt-1 text-[11px] text-warn truncate">Needs configuration</div>

    <!-- Outputs -->
    <template v-for="(h, i) in outputs" :key="'out-' + h.id">
      <Handle
        :id="h.id"
        type="source"
        :position="Position.Right"
        :style="{ top: handleTop(i, outputs.length) }"
        class="!size-3 !bg-surface !border-[1.5px] !border-line-strong hover:!border-brand"
      />
      <span
        v-if="h.label"
        class="absolute right-[-6px] translate-x-full -translate-y-1/2 pl-2 text-[10px] font-medium pointer-events-none max-w-[110px] truncate"
        :class="h.id === 'true' ? 'text-ok' : h.id === 'false' ? 'text-bad' : 'text-muted'"
        :style="{ top: handleTop(i, outputs.length) }"
      >{{ h.label }}</span>
    </template>
  </div>
</template>
