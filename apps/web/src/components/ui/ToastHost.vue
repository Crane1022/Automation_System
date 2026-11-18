<script setup lang="ts">
import { CircleCheck, CircleAlert, Info } from '@lucide/vue';
import { useToasts } from '@/lib/toast';
const toasts = useToasts();
</script>

<template>
  <div class="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-[340px]" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in toasts" :key="t.id" class="card shadow-[var(--shadow-pop)] px-3 py-2.5 flex items-start gap-2 text-[13px] border-l-[3px]" :class="t.kind === 'success' ? 'border-l-ok' : t.kind === 'error' ? 'border-l-bad' : 'border-l-info'">
        <CircleCheck v-if="t.kind === 'success'" class="size-4 text-ok shrink-0 mt-0.5" />
        <CircleAlert v-else-if="t.kind === 'error'" class="size-4 text-bad shrink-0 mt-0.5" />
        <Info v-else class="size-4 text-info shrink-0 mt-0.5" />
        <span class="text-ink">{{ t.message }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-active { transition: opacity 0.22s var(--ease-out), transform 0.28s var(--ease-spring); }
.toast-leave-active { transition: opacity 0.18s ease-in, transform 0.18s ease-in; position: absolute; width: 100%; }
.toast-enter-from { opacity: 0; transform: translateX(24px) scale(0.98); }
.toast-leave-to { opacity: 0; transform: translateX(24px); }
.toast-move { transition: transform 0.22s var(--ease-out); }
</style>
