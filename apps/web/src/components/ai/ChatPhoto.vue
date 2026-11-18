<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { ImageOff } from '@lucide/vue';
import { apiBlob } from '@/lib/api';

/** A photo stored inside a chat (loaded with the sign-in token). Click to see it big. */
const props = defineProps<{ chatId: string; imageId: string; name: string; width: number; height: number }>();
const url = ref<string | null>(null);
const failed = ref(false);
const big = ref(false);
onMounted(async () => {
  try {
    url.value = URL.createObjectURL(await apiBlob(`/assistant/chats/${props.chatId}/images/${props.imageId}`, { quiet: true }));
  } catch {
    failed.value = true;
  }
});
onBeforeUnmount(() => url.value && URL.revokeObjectURL(url.value));
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (big.value = false);
</script>

<template>
  <button
    class="block rounded-xl overflow-hidden border border-line bg-surface-2 shadow-sm hover:shadow-md transition-shadow"
    :style="{ aspectRatio: `${width} / ${height}`, width: width >= height ? '220px' : '150px' }"
    :title="name"
    :aria-label="`Open photo ${name}`"
    @click="big = true"
  >
    <img v-if="url" :src="url" :alt="name" class="size-full object-cover animate-in" />
    <span v-else-if="failed" class="size-full grid place-items-center text-subtle"><ImageOff class="size-5" /></span>
    <span v-else class="block size-full animate-pulse bg-surface-2" />
  </button>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="big && url" class="fixed inset-0 z-50 bg-black/80 grid place-items-center p-4 cursor-zoom-out" tabindex="-1" @click="big = false" @keydown="onKey">
        <img :src="url" :alt="name" class="max-w-full max-h-[88vh] rounded-lg shadow-2xl" />
        <p class="absolute bottom-4 text-white/80 text-[12px]">{{ name }}</p>
      </div>
    </Transition>
  </Teleport>
</template>
