<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { X } from '@lucide/vue';

defineProps<{ title: string; width?: string }>();
const emit = defineEmits<{ close: [] }>();

/** Shown after mount so it animates in; closing with X / Esc / the backdrop animates out first. */
const visible = ref(false);
const requestClose = () => (visible.value = false);
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && requestClose();
onMounted(() => {
  visible.value = true;
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <Transition name="modal" @after-leave="emit('close')">
      <div v-if="visible" class="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] grid place-items-center p-4" @mousedown.self="requestClose">
        <div class="modal-panel card shadow-[var(--shadow-pop)] w-full max-h-[90vh] flex flex-col" :style="{ maxWidth: width ?? '480px' }" role="dialog" :aria-label="title">
          <div class="flex items-center justify-between px-5 h-12 border-b border-line">
            <h2 class="section-title">{{ title }}</h2>
            <button class="btn-ghost btn-icon" aria-label="Close" data-no-loading @click="requestClose"><X class="size-4" /></button>
          </div>
          <div class="p-5 overflow-auto"><slot /></div>
          <div v-if="$slots.footer" class="px-5 py-3 border-t border-line flex justify-end gap-2 bg-surface-2 rounded-b-[var(--radius-card)]">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
