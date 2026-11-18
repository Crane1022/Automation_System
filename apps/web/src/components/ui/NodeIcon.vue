<script setup lang="ts">
import { computed } from 'vue';
import { iconFor, categoryStyle } from '@/lib/icons';
const props = defineProps<{ icon: string; category: string; size?: 'sm' | 'md' | 'lg' }>();
const box = computed(() => ({ sm: 'size-6 rounded', md: 'size-8 rounded-md', lg: 'size-10 rounded-lg' })[props.size ?? 'md']);
const ico = computed(() => ({ sm: 'size-3.5', md: 'size-4', lg: 'size-5' })[props.size ?? 'md']);
</script>

<template>
  <span class="grid place-items-center shrink-0" :class="[box, categoryStyle[category] ?? 'bg-surface-2 text-muted']">
    <component :is="iconFor(icon)" :class="ico" />
  </span>
</template>
