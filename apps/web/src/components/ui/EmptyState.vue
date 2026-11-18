<script setup lang="ts">
import type { Component } from 'vue';
defineProps<{ icon?: Component; title: string; text?: string }>();
</script>

<template>
  <div class="flex flex-col items-center justify-center text-center py-14 px-6">
    <div v-if="icon" class="size-10 rounded-lg bg-brand-soft text-brand grid place-items-center mb-3">
      <component :is="icon" class="size-5" />
    </div>
    <p class="section-title">{{ title }}</p>
    <p v-if="text" class="text-muted text-[13px] mt-1 max-w-sm">{{ text }}</p>
    <div class="mt-4"><slot /></div>
  </div>
</template>
