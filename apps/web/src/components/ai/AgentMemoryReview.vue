<script setup lang="ts">
import { computed, ref } from 'vue';
import { Brain, Check, Eye, Pencil, Search, Trash2, X } from '@lucide/vue';
import type { AssistantMemory } from '@widebed/shared';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';

/**
 * Admins only: what one AI employee remembers about each person, to correct
 * mistakes or remove things that shouldn't be there. Opening it is recorded in the Activity log.
 */
const props = defineProps<{ agentId: string; agentName: string }>();

type Row = AssistantMemory & { ownerName: string; ownerEmail: string | null };
const rows = ref<Row[] | null>(null);
const loading = ref(false);
const q = ref('');
const editing = ref<string | null>(null);
const draft = ref('');

async function load() {
  loading.value = true;
  try {
    rows.value = (await api<{ items: Row[] }>(`/agents/${props.agentId}/memories`)).items;
  } catch (err) {
    toastError(err);
  } finally {
    loading.value = false;
  }
}
const groups = computed(() => {
  const s = q.value.trim().toLowerCase();
  const map = new Map<string, { name: string; email: string | null; items: Row[] }>();
  for (const r of rows.value ?? []) {
    if (s && !`${r.text} ${r.ownerName}`.toLowerCase().includes(s)) continue;
    if (!map.has(r.ownerId)) map.set(r.ownerId, { name: r.ownerName, email: r.ownerEmail, items: [] });
    map.get(r.ownerId)!.items.push(r);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
});

function edit(r: Row) {
  editing.value = r.memoryId;
  draft.value = r.text;
}
async function saveEdit(r: Row) {
  try {
    const m = await api<AssistantMemory>(`/assistant/memories/${r.memoryId}`, { method: 'PATCH', body: { text: draft.value } });
    r.text = m.text;
    editing.value = null;
    toast('Memory corrected', 'success', 1500);
  } catch (err) {
    toastError(err);
  }
}
async function remove(r: Row) {
  if (!confirm(`Delete this from ${r.ownerName}’s memory?\n\n“${r.text}”`)) return;
  try {
    await api(`/assistant/memories/${r.memoryId}`, { method: 'DELETE' });
    rows.value = (rows.value ?? []).filter((x) => x.memoryId !== r.memoryId);
  } catch (err) {
    toastError(err);
  }
}
</script>

<template>
  <section class="card p-5 animate-in">
    <h2 class="section-title flex items-center gap-2"><Brain class="size-4 text-muted" />What {{ agentName }} remembers</h2>
    <p class="text-[12.5px] text-muted mt-1">
      Check and correct what it has saved about each person. Memory is private, so opening this list is recorded in the Activity log. Passwords, IC and card numbers are never saved.
    </p>

    <button v-if="rows === null" class="btn-secondary mt-4" :disabled="loading" @click="load"><Eye class="size-4" />Show memory</button>

    <template v-else>
      <div class="relative mt-4 max-w-[320px]">
        <Search class="size-4 text-subtle absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input v-model="q" class="input pl-8" placeholder="Search memory or person…" />
      </div>
      <p v-if="!groups.length" class="text-[13px] text-subtle mt-4">{{ rows.length ? 'Nothing matches.' : 'It doesn’t remember anything yet.' }}</p>
      <div v-for="g in groups" :key="g.name" class="mt-4 animate-in">
        <h3 class="text-[12.5px] font-medium">{{ g.name }} <span class="text-subtle font-normal">· {{ g.email }} · {{ g.items.length }}</span></h3>
        <ul class="mt-1.5 space-y-1">
          <li v-for="r in g.items" :key="r.memoryId" class="group flex items-start gap-2 rounded-md bg-surface-2 px-3 py-1.5 text-[13px]">
            <template v-if="editing === r.memoryId">
              <input v-model="draft" class="input h-8 flex-1" maxlength="300" @keydown.enter.prevent="saveEdit(r)" @keydown.esc="editing = null" />
              <button type="button" class="btn-ghost btn-icon size-8" aria-label="Save" @click="saveEdit(r)"><Check class="size-4 text-ok" /></button>
              <button type="button" class="btn-ghost btn-icon size-8" aria-label="Cancel" @click="editing = null"><X class="size-4" /></button>
            </template>
            <template v-else>
              <span class="flex-1 py-0.5">{{ r.text }}</span>
              <span class="text-[11px] text-subtle py-1 shrink-0">{{ timeAgo(r.createdAt) }}</span>
              <button type="button" class="btn-ghost btn-icon size-7 opacity-0 group-hover:opacity-100" aria-label="Correct" @click="edit(r)"><Pencil class="size-3.5" /></button>
              <button type="button" class="btn-ghost btn-icon size-7 opacity-0 group-hover:opacity-100" aria-label="Delete" @click="remove(r)"><Trash2 class="size-3.5" /></button>
            </template>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>
