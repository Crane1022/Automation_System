<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ status: string; size?: 'sm' | 'md' }>();

const styles: Record<string, string> = {
  success: 'bg-ok-soft text-ok',
  active: 'bg-ok-soft text-ok',
  failed: 'bg-bad-soft text-bad',
  running: 'bg-info-soft text-info',
  queued: 'bg-surface-2 text-muted',
  pending: 'bg-surface-2 text-muted',
  waiting: 'bg-warn-soft text-warn',
  cancelled: 'bg-surface-2 text-subtle',
  skipped: 'bg-surface-2 text-subtle',
  inactive: 'bg-surface-2 text-muted',
  disabled: 'bg-bad-soft text-bad',
};
const cls = computed(() => styles[props.status] ?? 'bg-surface-2 text-muted');
const label = computed(() => props.status.charAt(0).toUpperCase() + props.status.slice(1));
</script>

<template>
  <span class="inline-flex items-center gap-1.5 rounded-full font-medium transition-colors duration-300" :class="[cls, size === 'md' ? 'h-6 px-2.5 text-[12px]' : 'h-5 px-2 text-[11px]']">
    <!-- A live “ping” while something is running or queued -->
    <span class="relative size-1.5">
      <span v-if="['running', 'queued', 'waiting'].includes(status)" class="absolute inset-0 rounded-full bg-current animate-ping opacity-60" />
      <span class="absolute inset-0 rounded-full bg-current" />
    </span>
    {{ label }}
  </span>
</template>
