<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ value: unknown; maxHeight?: string }>();
const text = computed(() => (props.value === undefined ? '—' : JSON.stringify(props.value, null, 2)));
</script>

<template>
  <pre class="font-mono text-[12px] leading-relaxed bg-surface-2 border border-line rounded-md p-3 overflow-auto whitespace-pre-wrap break-all text-ink" :style="{ maxHeight: maxHeight ?? '320px' }">{{ text }}</pre>
</template>
