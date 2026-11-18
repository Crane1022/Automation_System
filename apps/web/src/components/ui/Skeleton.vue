<script setup lang="ts">
/**
 * Shimmering placeholders shown while a page loads its data.
 *   kind="list"  rows with an icon and two lines (workflows, credentials, chats)
 *   kind="table" table rows (executions, users, schedules)
 *   kind="cards" a grid of cards (templates, integrations)
 *   kind="tiles" the number tiles on Overview
 */
withDefaults(defineProps<{ kind?: 'list' | 'table' | 'cards' | 'tiles'; rows?: number }>(), { kind: 'list', rows: 5 });
const widths = ['62%', '48%', '71%', '55%', '66%', '44%', '58%', '69%'];
</script>

<template>
  <div role="status" aria-label="Loading" :aria-busy="true">
    <div v-if="kind === 'list'">
      <div v-for="i in rows" :key="i" class="flex items-center gap-3 px-4 py-3.5 border-b border-line last:border-0">
        <div class="skeleton size-9 shrink-0" />
        <div class="flex-1 space-y-2">
          <div class="skeleton h-3" :style="{ width: widths[i % widths.length] }" />
          <div class="skeleton h-2.5 w-1/3" />
        </div>
        <div class="skeleton h-5 w-16 rounded-full" />
      </div>
    </div>

    <div v-else-if="kind === 'table'">
      <div v-for="i in rows" :key="i" class="grid grid-cols-[2fr_1fr_1fr_1fr] gap-4 px-4 py-3 border-b border-line last:border-0">
        <div class="skeleton h-3" :style="{ width: widths[i % widths.length] }" />
        <div class="skeleton h-3 w-3/4" />
        <div class="skeleton h-3 w-1/2" />
        <div class="skeleton h-3 w-2/3" />
      </div>
    </div>

    <div v-else-if="kind === 'cards'" class="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
      <div v-for="i in rows" :key="i" class="card p-4 space-y-3">
        <div class="flex gap-1.5"><div class="skeleton size-6" /><div class="skeleton size-6" /><div class="skeleton size-6" /></div>
        <div class="skeleton h-3.5 w-2/3" />
        <div class="space-y-1.5"><div class="skeleton h-2.5" /><div class="skeleton h-2.5" :style="{ width: widths[i % widths.length] }" /></div>
        <div class="skeleton h-4 w-20 rounded" />
      </div>
    </div>

    <div v-else class="grid grid-cols-2 xl:grid-cols-4 gap-4">
      <div v-for="i in rows" :key="i" class="card p-4 space-y-3">
        <div class="skeleton h-3 w-1/2" />
        <div class="skeleton h-7 w-1/3" />
        <div class="skeleton h-2.5 w-2/3" />
      </div>
    </div>
  </div>
</template>
