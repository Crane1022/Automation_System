<script setup lang="ts">
import { Construction } from '@lucide/vue';
import { aiTeamUpcoming } from '@/lib/ai-team-preview';

/** "Under construction" notice for the AI Team, with a card for each page that is coming. */
defineProps<{ compact?: boolean }>();
</script>

<template>
  <div class="text-center">
    <div class="h-2.5 -mx-5 -mt-5 mb-6 bg-[repeating-linear-gradient(135deg,#f2b84b_0_14px,#0f1a33_14px_28px)]" aria-hidden="true" />
    <div class="mx-auto size-16 rounded-2xl bg-warn-soft text-warn grid place-items-center mb-4">
      <Construction class="size-8" />
    </div>
    <p class="text-[12px] font-semibold uppercase tracking-[0.12em] text-warn">AI Team</p>
    <h2 class="mt-1 text-[30px] leading-tight font-bold tracking-tight text-ink">Under construction</h2>
    <p class="mt-2 text-[15px] font-semibold text-bad">Do not use it yet.</p>
    <p class="mt-1.5 text-[13px] text-muted max-w-md mx-auto">We're still building this. Here's what's coming to the AI Team:</p>

    <div class="mt-6 grid gap-3 text-left" :class="compact ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3'">
      <div v-for="(p, i) in aiTeamUpcoming" :key="p.title" class="card p-3.5 flex gap-3 animate-in" :style="{ '--i': i }">
        <span class="size-9 shrink-0 rounded-lg bg-brand-soft text-brand grid place-items-center"><component :is="p.icon" class="size-4.5" /></span>
        <span class="min-w-0">
          <span class="flex items-center gap-2">
            <span class="text-[13.5px] font-semibold text-ink">{{ p.title }}</span>
            <span class="chip h-4.5 text-[10px] bg-warn-soft text-warn border-transparent">Coming soon</span>
          </span>
          <span class="block text-[12px] text-muted mt-0.5 leading-snug">{{ p.text }}</span>
        </span>
      </div>
    </div>
  </div>
</template>
