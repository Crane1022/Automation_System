<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { BookOpen, Lightbulb } from '@lucide/vue';
import Modal from '@/components/ui/Modal.vue';
import { GUIDES, guideForPath, type GuideKey } from '@/lib/guides';

/**
 * "Guide" button in the top-right corner of every page. Opens a pop-up in the middle
 * of the screen with simple steps and examples. Without a `guide` prop it picks the
 * guide from the current URL.
 */
const props = defineProps<{ guide?: GuideKey }>();
const route = useRoute();
const open = ref(false);
const guide = computed(() => {
  const key = props.guide ?? guideForPath(route.path);
  return key ? GUIDES[key] : null;
});
watch(() => route.path, () => (open.value = false));
</script>

<template>
  <span class="inline-flex">
    <button
      v-if="guide"
      type="button"
      class="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-line bg-surface text-[12px] font-medium text-muted hover:text-brand hover:border-brand transition-colors"
      :title="`How to use ${guide.title}`"
      :aria-label="`Open the guide for ${guide.title}`"
      @click="open = true"
    >
      <BookOpen class="size-3.5" />Guide
    </button>

    <Modal v-if="open && guide" :title="`${guide.title} — guide`" width="680px" @close="open = false">
      <p class="text-[13px] text-muted -mt-1 mb-5">{{ guide.summary }}</p>
      <div class="space-y-6">
        <section v-for="(s, i) in guide.sections" :key="i">
          <h3 class="flex items-center gap-2 text-[14px] font-semibold mb-2">
            <span class="size-5 rounded-full bg-brand text-white text-[11px] grid place-items-center shrink-0">{{ i + 1 }}</span>{{ s.title }}
          </h3>
          <p v-if="s.text" class="text-[13px] leading-relaxed mb-2">{{ s.text }}</p>
          <ol v-if="s.steps" class="space-y-1.5 text-[13px] leading-relaxed">
            <li v-for="(st, k) in s.steps" :key="k" class="flex gap-2">
              <span class="text-subtle tabular-nums shrink-0 w-4 text-right">{{ k + 1 }}.</span><span>{{ st }}</span>
            </li>
          </ol>
          <div v-if="s.example" class="mt-3 rounded-md border border-line bg-surface-2 p-3">
            <div class="text-[11px] uppercase tracking-wide font-semibold text-subtle mb-1.5">{{ s.example.title }}</div>
            <div v-for="(l, k) in s.example.lines" :key="k" class="text-[12.5px] font-mono leading-relaxed break-words">{{ l }}</div>
          </div>
          <div v-if="s.tip" class="mt-3 flex gap-2 rounded-md bg-info-soft text-info text-[12.5px] p-2.5 leading-relaxed">
            <Lightbulb class="size-4 shrink-0 mt-0.5" /><span>{{ s.tip }}</span>
          </div>
        </section>
      </div>
      <template #footer>
        <span class="mr-auto self-center text-[12px] text-subtle">Each node also has its own help: click it in the editor → <b>Docs</b> tab.</span>
        <button class="btn-primary" @click="open = false">Got it</button>
      </template>
    </Modal>
  </span>
</template>
