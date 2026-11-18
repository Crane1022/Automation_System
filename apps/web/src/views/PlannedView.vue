<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { Construction } from '@lucide/vue';

/** Honest placeholder for modules that are scheduled for later phases. */
const route = useRoute();
const plans: Record<string, { phase: number; text: string; items: string[] }> = {
  '/integrations': { phase: 3, text: 'Connect Gmail, Google Sheets, OpenAI and more with OAuth 2.0.', items: ['Connect / disconnect', 'Test connection', 'Connection status & last tested', 'Per-integration docs'] },
  '/ai-agents': { phase: 3, text: 'Configure AI agents that can call authorised workflow tools.', items: ['Model, prompt, temperature, max tokens', 'Tool permissions with input validation', 'Knowledge sources', 'Sessions & history'] },
  '/templates': { phase: 3, text: 'Start new workflows from ready-made Widebed templates.', items: ['Tenant reminders', 'Daily KPI to Sheets', 'Import / export'] },
};
const plan = computed(() => plans[route.path]);
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[880px] mx-auto">
    <h1 class="page-title">{{ route.meta.title }}</h1>
    <div class="card p-8 mt-6 text-center">
      <div class="size-11 rounded-lg bg-moss-soft text-moss grid place-items-center mx-auto mb-3"><Construction class="size-5" /></div>
      <p class="section-title">Planned for Phase {{ plan?.phase }}</p>
      <p class="text-muted text-[13px] mt-1">{{ plan?.text }}</p>
      <ul class="mt-5 inline-grid gap-1.5 text-left text-[13px] text-muted">
        <li v-for="i in plan?.items" :key="i" class="flex gap-2"><span class="text-moss">•</span>{{ i }}</li>
      </ul>
      <p class="text-[12px] text-subtle mt-6">Nothing on this page is functional yet, so there are no buttons to press.</p>
    </div>
  </div>
</template>
