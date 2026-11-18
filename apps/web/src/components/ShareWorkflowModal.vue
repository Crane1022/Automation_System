<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Search, Share2, X } from '@lucide/vue';
import type { PersonSummary } from '@widebed/shared';
import Modal from '@/components/ui/Modal.vue';
import { api } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';

/**
 * Pick people who may open and run a workflow (they can't change it).
 * Department managers already see their department's workflows, so this is
 * mainly for sharing with someone in another department or an employee.
 */
const props = defineProps<{ workflow: { workflowId: string; name: string; ownerId: string; sharedWith: string[] } }>();
const emit = defineEmits<{ close: []; saved: [sharedWith: string[]] }>();

const people = ref<PersonSummary[]>([]);
const loading = ref(true);
const saving = ref(false);
const chosen = ref<string[]>([...props.workflow.sharedWith]);
const q = ref('');

onMounted(async () => {
  try {
    people.value = (await api<{ items: PersonSummary[] }>('/people')).items;
  } catch (err) {
    toastError(err);
  } finally {
    loading.value = false;
  }
});

const byId = computed(() => new Map(people.value.map((p) => [p.uid, p])));
const owner = computed(() => byId.value.get(props.workflow.ownerId));
const matches = computed(() => {
  const s = q.value.trim().toLowerCase();
  return people.value
    .filter((p) => p.uid !== props.workflow.ownerId && !chosen.value.includes(p.uid))
    .filter((p) => !s || `${p.name} ${p.email} ${p.department ?? ''}`.toLowerCase().includes(s))
    .slice(0, 8);
});

function add(uid: string) {
  chosen.value.push(uid);
  q.value = '';
}
function remove(uid: string) {
  chosen.value = chosen.value.filter((x) => x !== uid);
}

async function save() {
  saving.value = true;
  // Drop anyone who lost access since (the server would refuse them).
  chosen.value = chosen.value.filter((uid) => byId.value.has(uid));
  try {
    const res = await api<{ sharedWith: string[] }>(`/workflows/${props.workflow.workflowId}`, { method: 'PATCH', body: { sharedWith: chosen.value } });
    toast(chosen.value.length ? `Shared with ${chosen.value.length} ${chosen.value.length === 1 ? 'person' : 'people'}` : 'Sharing turned off', 'success');
    emit('saved', res.sharedWith);
    emit('close');
  } catch (err) {
    toastError(err);
  } finally {
    saving.value = false;
  }
}
const initials = (n: string) => n.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
</script>

<template>
  <Modal :title="`Share “${workflow.name}”`" width="520px" @close="emit('close')">
    <p class="text-[12px] text-muted -mt-1 mb-4">
      People you add can <b>see and run</b> this workflow and its history. They <b>can’t change</b> it. Admins and your department manager can already see it.
    </p>

    <div class="relative">
      <Search class="size-4 text-subtle absolute left-2.5 top-1/2 -translate-y-1/2" />
      <input v-model="q" class="input pl-8" placeholder="Type a name, email or department…" :disabled="loading" autofocus />
    </div>
    <ul v-if="q || matches.length" class="mt-1.5 card divide-y divide-line max-h-[220px] overflow-y-auto">
      <li v-if="loading" class="px-3 py-2 text-[13px] text-subtle">Loading people…</li>
      <li v-else-if="!matches.length" class="px-3 py-2 text-[13px] text-subtle">No one matches “{{ q }}”.</li>
      <li v-for="p in matches" :key="p.uid">
        <button class="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-2" @click="add(p.uid)">
          <span class="size-7 rounded-full bg-moss-soft text-moss grid place-items-center text-[11px] font-semibold shrink-0">{{ initials(p.name) }}</span>
          <span class="min-w-0 flex-1">
            <span class="block text-[13px] font-medium truncate">{{ p.name }}</span>
            <span class="block text-[11px] text-subtle truncate">{{ p.email }}<template v-if="p.department"> · {{ p.department }}</template></span>
          </span>
          <span class="text-[12px] text-brand">Add</span>
        </button>
      </li>
    </ul>

    <h3 class="text-[12px] font-medium text-muted mt-5 mb-2">Who has access</h3>
    <ul class="space-y-1.5">
      <li v-if="owner" class="flex items-center gap-2.5 text-[13px]">
        <span class="size-7 rounded-full bg-brand-soft text-brand grid place-items-center text-[11px] font-semibold">{{ initials(owner.name) }}</span>
        <span class="flex-1 min-w-0 truncate">{{ owner.name }} <span class="text-subtle">· {{ owner.email }}</span></span>
        <span class="text-[12px] text-subtle">Owner</span>
      </li>
      <li v-for="uid in chosen" :key="uid" class="animate-in flex items-center gap-2.5 text-[13px]">
        <span class="size-7 rounded-full bg-moss-soft text-moss grid place-items-center text-[11px] font-semibold">{{ initials(byId.get(uid)?.name ?? '?') }}</span>
        <span class="flex-1 min-w-0 truncate">{{ byId.get(uid)?.name ?? 'Someone who no longer has access' }} <span v-if="byId.get(uid)" class="text-subtle">· {{ byId.get(uid)?.email }}</span></span>
        <span class="text-[12px] text-subtle">Can run</span>
        <button class="btn-ghost btn-icon size-7" :aria-label="`Remove ${byId.get(uid)?.name ?? ''}`" @click="remove(uid)"><X class="size-3.5" /></button>
      </li>
      <li v-if="!chosen.length && !loading" class="text-[12px] text-subtle">Not shared with anyone yet.</li>
    </ul>

    <template #footer>
      <button class="btn-secondary" @click="emit('close')">Cancel</button>
      <button class="btn-primary" :disabled="saving || loading" @click="save"><Share2 class="size-4" />Save sharing</button>
    </template>
  </Modal>
</template>
