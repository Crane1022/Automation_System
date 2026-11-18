<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { isBusy } from '@/lib/loading';

/**
 * A thin bar along the top of the window while a page or a request is loading.
 * Waits 200 ms before showing (fast loads stay invisible), creeps towards 90 %, then completes and fades.
 */
const width = ref(0);
const visible = ref(false);
let showTimer: ReturnType<typeof setTimeout> | null = null;
let creep: ReturnType<typeof setInterval> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function start() {
  if (hideTimer) clearTimeout(hideTimer);
  if (visible.value || showTimer) return;
  showTimer = setTimeout(() => {
    showTimer = null;
    visible.value = true;
    width.value = 8;
    creep = setInterval(() => {
      width.value = Math.min(90, width.value + (90 - width.value) * 0.08);
    }, 200);
  }, 200);
}

function finish() {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (!visible.value) return;
  if (creep) clearInterval(creep);
  creep = null;
  width.value = 100;
  hideTimer = setTimeout(() => {
    visible.value = false;
    width.value = 0;
  }, 300);
}

watch(isBusy, (b) => (b ? start() : finish()), { immediate: true });
onBeforeUnmount(() => {
  [showTimer, hideTimer].forEach((t) => t && clearTimeout(t));
  if (creep) clearInterval(creep);
});
</script>

<template>
  <div class="fixed top-0 inset-x-0 z-[200] h-[2.5px] pointer-events-none" aria-hidden="true">
    <div
      class="h-full bg-brand shadow-[0_0_8px_var(--wb-brand)] transition-[width,opacity] ease-out"
      :class="visible ? 'opacity-100 duration-200' : 'opacity-0 duration-300'"
      :style="{ width: `${width}%` }"
    />
  </div>
</template>
