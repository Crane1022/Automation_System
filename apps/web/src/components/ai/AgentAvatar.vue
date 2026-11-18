<script setup lang="ts">
import { computed } from 'vue';

/** An AI employee's face: its emoji on a soft coloured circle. Breathes while it works. */
const props = withDefaults(defineProps<{ avatar: string; color?: string; size?: number; working?: boolean; muted?: boolean }>(), { color: 'brand', size: 40, working: false, muted: false });

const COLORS: Record<string, { bg: string; bgDark: string; ring: string }> = {
  brand: { bg: '#e3efe6', bgDark: '#1f3327', ring: '#2f7d4f' },
  blue: { bg: '#e2ecf8', bgDark: '#1d2a3a', ring: '#2f6db5' },
  amber: { bg: '#f8eedb', bgDark: '#3a2e1a', ring: '#b7791f' },
  rose: { bg: '#f8e3e6', bgDark: '#3a1f24', ring: '#c0485a' },
  violet: { bg: '#ece5f6', bgDark: '#2a2236', ring: '#6c4a8f' },
  slate: { bg: '#e7e9ec', bgDark: '#262a2f', ring: '#5b6470' },
};
const c = computed(() => COLORS[props.color] ?? COLORS.brand!);
</script>

<template>
  <span
    class="agent-avatar relative inline-grid place-items-center rounded-full shrink-0 select-none transition-[filter,opacity] duration-200"
    :class="{ 'agent-working': working, 'grayscale opacity-60': muted }"
    :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.5)}px`, '--agent': c.ring, '--bg': c.bg, '--bg-dark': c.bgDark }"
    aria-hidden="true"
  >
    {{ avatar }}
    <span v-if="working" class="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-surface" :style="{ background: c.ring }" />
  </span>
</template>

<style scoped>
.agent-avatar { background: var(--bg); line-height: 1; }
:global(.dark) .agent-avatar { background: var(--bg-dark); }
</style>
