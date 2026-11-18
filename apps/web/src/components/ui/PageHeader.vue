<script setup lang="ts">
import GuideButton from '@/components/ui/GuideButton.vue';
import type { GuideKey } from '@/lib/guides';

/**
 * The header at the top of every page: title + short description on the left,
 * the page's buttons on the right, and the Guide button in the top-right corner.
 * Use this on every new page so the layout stays the same everywhere.
 */
defineProps<{ title?: string; subtitle?: string; guide?: GuideKey }>();
</script>

<template>
  <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 mb-6">
    <div class="min-w-0">
      <slot name="title"><h1 class="page-title">{{ title }}</h1></slot>
      <p v-if="subtitle" class="text-muted text-[13px] mt-0.5">{{ subtitle }}</p>
      <slot name="below" />
    </div>
    <div class="flex flex-wrap items-center gap-2 ml-auto">
      <slot />
      <GuideButton :guide="guide" />
    </div>
  </div>
</template>
