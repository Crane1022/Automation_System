<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Archive, CircleAlert, Copy, MessageSquare, MoreHorizontal, Pencil, Plus, Power, Search, Settings2, Trash2, UserPlus, Users } from '@lucide/vue';
import type { AgentSummary, AgentTemplate } from '@widebed/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import Modal from '@/components/ui/Modal.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AgentAvatar from '@/components/ai/AgentAvatar.vue';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();

const agents = ref<AgentSummary[]>([]);
const canManage = ref(false);
const loading = ref(true);
const q = ref('');
const showArchived = ref(false);
const menuFor = ref<string | null>(null);

async function load(quiet = false) {
  try {
    const res = await api<{ items: AgentSummary[]; canManage: boolean }>('/agents', { quiet });
    agents.value = res.items;
    canManage.value = res.canManage;
  } catch (err) {
    if (!quiet) toastError(err);
  } finally {
    loading.value = false;
  }
}
// Refresh now and then so "working" badges stay current.
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  load();
  timer = setInterval(() => load(true), 8000);
  document.addEventListener('click', closeMenu);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  document.removeEventListener('click', closeMenu);
});
function closeMenu() {
  menuFor.value = null;
}

const shown = computed(() => {
  const s = q.value.trim().toLowerCase();
  return agents.value
    .filter((a) => (showArchived.value ? a.status === 'archived' : a.status !== 'archived'))
    .filter((a) => !s || `${a.name} ${a.title} ${a.department ?? ''} ${a.description} ${a.expertise.join(' ')}`.toLowerCase().includes(s))
    .sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || Number(b.status === 'active') - Number(a.status === 'active') || a.name.localeCompare(b.name));
});
const counts = computed(() => ({
  total: agents.value.filter((a) => a.status !== 'archived').length,
  active: agents.value.filter((a) => a.status === 'active').length,
  working: agents.value.filter((a) => a.working).length,
  archived: agents.value.filter((a) => a.status === 'archived').length,
}));

/* ---------- create ---------- */
const picking = ref(false);
const templates = ref<AgentTemplate[]>([]);
async function openPicker() {
  picking.value = true;
  if (!templates.value.length) templates.value = (await api<{ items: AgentTemplate[] }>('/agents/templates')).items;
}
async function fromTemplate(t: AgentTemplate) {
  try {
    const a = await api<{ agentId: string; name: string }>('/agents', { method: 'POST', body: { templateId: t.templateId } });
    toast(`${a.name} has joined the team`, 'success');
    picking.value = false;
    router.push(`/ai-staff/${a.agentId}/edit?new=1`);
  } catch (err) {
    toastError(err);
  }
}

/* ---------- manage ---------- */
async function setStatus(a: AgentSummary, status: 'active' | 'disabled' | 'archived') {
  menuFor.value = null;
  if (status === 'archived' && !confirm(`Archive ${a.name}? It disappears from the team and nobody can chat with it. You can bring it back later.`)) return;
  try {
    await api(`/agents/${a.agentId}/status`, { method: 'POST', body: { status } });
    toast(status === 'active' ? `${a.name} is switched on` : status === 'disabled' ? `${a.name} is switched off` : `${a.name} is archived`, 'success');
    load(true);
  } catch (err) {
    toastError(err);
  }
}
async function duplicate(a: AgentSummary) {
  menuFor.value = null;
  try {
    const copy = await api<{ agentId: string }>(`/agents/${a.agentId}/duplicate`, { method: 'POST' });
    router.push(`/ai-staff/${copy.agentId}/edit`);
  } catch (err) {
    toastError(err);
  }
}
async function remove(a: AgentSummary) {
  menuFor.value = null;
  if (!confirm(`Delete ${a.name} for good?\n\nIts settings are removed. Chats people had with it stay in their history.`)) return;
  try {
    await api(`/agents/${a.agentId}`, { method: 'DELETE' });
    toast(`${a.name} was deleted`, 'success');
    load(true);
  } catch (err) {
    toastError(err);
  }
}

const open = (a: AgentSummary) => {
  if (a.status === 'active') router.push(`/ai-staff/${a.agentId}/chat`);
  else if (a.canEdit) router.push(`/ai-staff/${a.agentId}/edit`);
};
const toolNames = (a: AgentSummary) =>
  [a.canDelegate && 'Manager', a.tools.pms && 'PMS', a.tools.workflows && 'Workflows', a.tools.browser && 'Websites', a.tools.memory && 'Memory'].filter(Boolean) as string[];
const visibilityLabel = { private: 'Private', department: 'Department', company: 'Everyone' } as const;
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1280px] mx-auto">
    <PageHeader title="AI Staff" subtitle="Your team of AI employees. Click one to chat with it — each has its own job, instructions, memory and tools.">
      <RouterLink v-if="auth.can('credential.manage')" to="/ai-agents" class="btn-secondary"><Settings2 class="size-4" />AI Settings</RouterLink>
      <button v-if="canManage" class="btn-primary" @click.stop="openPicker"><UserPlus class="size-4" />New AI employee</button>
    </PageHeader>

    <!-- Team numbers -->
    <div class="grid grid-cols-3 gap-3 mb-5 max-w-[560px]">
      <div class="card px-4 py-3 animate-in"><div class="text-[12px] text-subtle">AI employees</div><div class="text-[22px] font-semibold tabular-nums">{{ counts.total }}</div></div>
      <div class="card px-4 py-3 animate-in" style="--i: 1"><div class="text-[12px] text-subtle">Switched on</div><div class="text-[22px] font-semibold tabular-nums">{{ counts.active }}</div></div>
      <div class="card px-4 py-3 animate-in" style="--i: 2">
        <div class="text-[12px] text-subtle">Working now</div>
        <div class="text-[22px] font-semibold tabular-nums flex items-center gap-2">{{ counts.working }}<span v-if="counts.working" class="size-2 rounded-full bg-ok animate-pulse" /></div>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2 mb-4">
      <div class="relative w-full sm:w-[280px]">
        <Search class="size-4 text-subtle absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input v-model="q" class="input pl-8" placeholder="Search by name, job or department…" />
      </div>
      <button v-if="canManage && counts.archived" class="btn-ghost h-9 text-[13px] ml-auto" data-no-loading @click="showArchived = !showArchived">
        <Archive class="size-4" />{{ showArchived ? 'Back to the team' : `Archived (${counts.archived})` }}
      </button>
    </div>

    <Skeleton v-if="loading" kind="cards" :rows="6" />
    <div v-else-if="!shown.length" class="card">
      <EmptyState :icon="Users" :title="q ? 'No one matches' : showArchived ? 'Nothing archived' : 'No AI employees yet'" :text="q ? 'Try another word.' : 'Admins can add AI employees with “New AI employee”.'" />
    </div>

    <div v-else class="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
      <article
        v-for="(a, idx) in shown"
        :key="a.agentId"
        class="card lift p-4 flex flex-col cursor-pointer animate-in"
        :class="a.status !== 'active' ? 'opacity-75' : ''"
        :style="{ '--i': Math.min(idx, 10) }"
        tabindex="0"
        @click="open(a)"
        @keydown.enter="open(a)"
      >
        <div class="flex items-start gap-3">
          <AgentAvatar :avatar="a.avatar" :color="a.color" :size="46" :working="a.working" :muted="a.status !== 'active'" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <h2 class="font-semibold text-[14.5px] truncate">{{ a.name }}</h2>
              <span v-if="a.builtIn" class="chip text-[10.5px] h-5">Built-in</span>
            </div>
            <p class="text-[12.5px] text-muted truncate">{{ a.title || 'AI employee' }}<template v-if="a.department"> · {{ a.department }}</template></p>
            <p class="text-[12px] mt-1 flex items-center gap-1.5" :class="a.working ? 'text-ok' : a.status !== 'active' ? 'text-subtle' : a.problem ? 'text-warn' : 'text-subtle'">
              <span class="size-1.5 rounded-full" :class="a.working ? 'bg-ok animate-pulse' : a.status !== 'active' ? 'bg-line-strong' : a.problem ? 'bg-warn' : 'bg-ok'" />
              {{ a.working ? 'Working on your request…' : a.status === 'disabled' ? 'Switched off' : a.status === 'archived' ? 'Archived' : a.problem ? 'Needs setting up' : 'Available' }}
            </p>
          </div>
          <div v-if="a.canEdit" class="relative" @click.stop>
            <button class="btn-ghost btn-icon size-8" :aria-label="`More for ${a.name}`" @click="menuFor = menuFor === a.agentId ? null : a.agentId"><MoreHorizontal class="size-4" /></button>
            <Transition name="pop">
              <div v-if="menuFor === a.agentId" class="absolute right-0 top-9 z-20 w-[190px] card shadow-[var(--shadow-pop)] py-1 text-[13px]">
                <button class="w-full flex items-center gap-2 px-3 h-8 hover:bg-surface-2" @click="router.push(`/ai-staff/${a.agentId}/edit`)"><Pencil class="size-4 text-muted" />Edit</button>
                <template v-if="a.canManage">
                <button class="w-full flex items-center gap-2 px-3 h-8 hover:bg-surface-2" @click="duplicate(a)"><Copy class="size-4 text-muted" />Duplicate</button>
                <button v-if="a.status === 'active'" class="w-full flex items-center gap-2 px-3 h-8 hover:bg-surface-2" @click="setStatus(a, 'disabled')"><Power class="size-4 text-muted" />Switch off</button>
                <button v-else class="w-full flex items-center gap-2 px-3 h-8 hover:bg-surface-2" @click="setStatus(a, 'active')"><Power class="size-4 text-ok" />Switch on</button>
                <button v-if="!a.builtIn && a.status !== 'archived'" class="w-full flex items-center gap-2 px-3 h-8 hover:bg-surface-2" @click="setStatus(a, 'archived')"><Archive class="size-4 text-muted" />Archive</button>
                <button v-if="a.status === 'archived'" class="w-full flex items-center gap-2 px-3 h-8 hover:bg-surface-2 text-bad" @click="remove(a)"><Trash2 class="size-4" />Delete for good</button>
                </template>
              </div>
            </Transition>
          </div>
        </div>

        <p class="text-[13px] text-muted mt-3 line-clamp-2 min-h-[2.6em]">{{ a.description || 'No description yet.' }}</p>

        <div class="flex flex-wrap gap-1 mt-3">
          <span v-for="t in toolNames(a)" :key="t" class="chip text-[11px] h-5">{{ t }}</span>
        </div>

        <p v-if="a.problem && a.status === 'active'" class="mt-3 text-[12px] text-warn flex gap-1.5 items-start"><CircleAlert class="size-3.5 mt-0.5 shrink-0" />{{ a.problem }}</p>

        <div class="mt-auto pt-3 border-t border-line flex items-center gap-3 text-[11.5px] text-subtle mt-3">
          <span class="truncate" :title="a.aiName ?? ''">{{ a.aiName ?? 'No AI chosen' }}</span>
          <span class="ml-auto shrink-0 flex items-center gap-1"><MessageSquare class="size-3" />{{ a.chats }}</span>
          <span class="shrink-0">{{ visibilityLabel[a.visibility] }}</span>
          <span v-if="a.lastActiveAt" class="shrink-0" :title="new Date(a.lastActiveAt).toLocaleString()">{{ timeAgo(a.lastActiveAt) }}</span>
        </div>
      </article>

      <button
        v-if="canManage && !showArchived && !q"
        class="card lift border-dashed p-4 flex flex-col items-center justify-center gap-2 text-muted hover:text-brand hover:border-brand min-h-[200px] animate-in"
        :style="{ '--i': Math.min(shown.length, 10) }"
        @click.stop="openPicker"
      >
        <span class="size-11 rounded-full bg-surface-2 grid place-items-center"><Plus class="size-5" /></span>
        <span class="text-[13px] font-medium">Add an AI employee</span>
      </button>
    </div>

    <!-- Template picker -->
    <Modal v-if="picking" title="New AI employee" width="760px" @close="picking = false">
      <p class="text-[13px] text-muted -mt-1 mb-4">Start from a ready-made job, or from scratch. You can change everything afterwards.</p>
      <div class="grid sm:grid-cols-2 gap-2.5">
        <button class="card lift p-3 text-left flex gap-3 items-start border-dashed hover:border-brand" @click="router.push('/ai-staff/new')">
          <span class="size-10 rounded-full bg-surface-2 grid place-items-center shrink-0"><Plus class="size-5 text-muted" /></span>
          <span><span class="block font-medium text-[13.5px]">Start from scratch</span><span class="block text-[12px] text-muted mt-0.5">Write its job and instructions yourself.</span></span>
        </button>
        <div v-if="!templates.length" class="skeleton h-[72px] rounded-lg" />
        <button v-for="(t, i) in templates" :key="t.templateId" class="card lift p-3 text-left flex gap-3 items-start hover:border-brand animate-in" :style="{ '--i': i }" @click="fromTemplate(t)">
          <AgentAvatar :avatar="t.agent.avatar" :color="t.agent.color ?? 'brand'" :size="40" />
          <span class="min-w-0">
            <span class="block font-medium text-[13.5px]">{{ t.agent.name }}</span>
            <span class="block text-[12px] text-muted mt-0.5">{{ t.pitch }}</span>
          </span>
        </button>
      </div>
    </Modal>
  </div>
</template>
