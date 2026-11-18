<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { CalendarClock, Check, CircleX, ClipboardCopy, Clock, FileDown, ListTodo, Loader2, RotateCcw, Send, Square, X } from '@lucide/vue';
import type { AgentSummary, AgentTask } from '@widebed/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import Modal from '@/components/ui/Modal.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AgentAvatar from '@/components/ai/AgentAvatar.vue';
import { api, apiBlob } from '@/lib/api';
import { downloadBlob } from '@/lib/download';
import { timeAgo } from '@/lib/format';
import { renderMarkdown } from '@/lib/markdown';
import { toast, toastError } from '@/lib/toast';
import { useAuthStore } from '@/stores/auth';

/** Task Center: everything AI staff did or are doing in the background. */
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const tasks = ref<AgentTask[]>([]);
const agents = ref<AgentSummary[]>([]);
const loading = ref(true);
const agentFilter = ref<string>(typeof route.query.agentId === 'string' ? route.query.agentId : '');
const statusFilter = ref('');
const sourceFilter = ref('');
const todayOnly = ref(false);
const openId = ref<string | null>(typeof route.query.task === 'string' ? route.query.task : null);

const byAgent = computed(() => new Map(agents.value.map((a) => [a.agentId, a])));
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

async function load(quiet = false) {
  try {
    const [t, a] = await Promise.all([
      api<{ items: AgentTask[] }>('/agent-tasks', { query: { agentId: agentFilter.value || undefined, status: statusFilter.value || undefined, source: sourceFilter.value || undefined, since: todayOnly.value ? startOfToday() : undefined }, quiet }),
      agents.value.length ? Promise.resolve({ items: agents.value }) : api<{ items: AgentSummary[] }>('/agents', { quiet: true }),
    ]);
    tasks.value = t.items;
    agents.value = a.items;
  } catch (err) {
    if (!quiet) toastError(err);
  } finally {
    loading.value = false;
  }
}
watch([agentFilter, statusFilter, sourceFilter, todayOnly], () => {
  router.replace({ query: { ...route.query, agentId: agentFilter.value || undefined } });
  load();
});

// Refresh while something is queued or running.
const active = computed(() => tasks.value.some((t) => t.status === 'queued' || t.status === 'running' || t.status === 'waiting_approval'));
let timer: ReturnType<typeof setInterval> | null = null;
watch(active, (on) => {
  if (on && !timer) timer = setInterval(() => load(true), 2500);
  if (!on && timer) {
    clearInterval(timer);
    timer = null;
  }
});
onMounted(() => load());
onBeforeUnmount(() => timer && clearInterval(timer));

const counts = computed(() => ({
  running: tasks.value.filter((t) => t.status === 'running' || t.status === 'queued').length,
  done: tasks.value.filter((t) => t.status === 'completed').length,
  failed: tasks.value.filter((t) => t.status === 'failed').length,
}));
const opened = computed(() => tasks.value.find((t) => t.taskId === openId.value) ?? null);
watch(openId, (id) => router.replace({ query: { ...route.query, task: id ?? undefined } }));

const STATUS = {
  queued: { label: 'Waiting', cls: 'text-muted bg-surface-2' },
  running: { label: 'Working', cls: 'text-info bg-info-soft' },
  waiting_approval: { label: 'Needs approval', cls: 'text-warn bg-warn-soft' },
  completed: { label: 'Done', cls: 'text-ok bg-ok-soft' },
  failed: { label: 'Failed', cls: 'text-bad bg-bad-soft' },
  cancelled: { label: 'Cancelled', cls: 'text-subtle bg-surface-2' },
} as const;
const duration = (t: AgentTask) => {
  const ms = t.durationMs ?? (t.startedAt ? Date.now() - Date.parse(t.startedAt) : null);
  if (ms === null) return '';
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`;
};

async function cancel(t: AgentTask) {
  try {
    await api(`/agent-tasks/${t.taskId}/cancel`, { method: 'POST' });
    toast('Stopping…', 'success', 1500);
    load(true);
  } catch (err) {
    toastError(err);
  }
}
async function retry(t: AgentTask) {
  try {
    await api(`/agent-tasks/${t.taskId}/retry`, { method: 'POST' });
    toast('Running it again', 'success', 1500);
    load(true);
  } catch (err) {
    toastError(err);
  }
}
async function copy(text: string) {
  await navigator.clipboard.writeText(text).then(() => toast('Copied', 'success', 1200)).catch(() => toast('Your browser blocked copying', 'error'));
}
async function download(f: { fileId: string; name: string }) {
  try {
    downloadBlob(await apiBlob(`/assistant/files/${f.fileId}`), f.name);
  } catch (err) {
    toastError(err);
  }
}

/* ---------- give a task ---------- */
const giving = ref(false);
const form = ref({ agentId: '', instructions: '', priority: 'normal' as AgentTask['priority'] });
const chatAgents = computed(() => agents.value.filter((a) => a.status === 'active' && !a.problem));
function openGive() {
  form.value = { agentId: agentFilter.value || chatAgents.value[0]?.agentId || '', instructions: '', priority: 'normal' };
  giving.value = true;
}
async function give() {
  try {
    const t = await api<AgentTask>('/agent-tasks', { method: 'POST', body: form.value });
    giving.value = false;
    tasks.value.unshift(t);
    openId.value = t.taskId;
    toast(`${t.agentName} is on it — you can close this page`, 'success');
  } catch (err) {
    toastError(err);
  }
}
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1280px] mx-auto">
    <PageHeader title="AI Tasks" subtitle="Work your AI staff do in the background — given by you, or started by a schedule. It keeps going even when you close the app.">
      <RouterLink to="/ai-schedules" class="btn-secondary"><CalendarClock class="size-4" />Schedules</RouterLink>
      <button class="btn-primary" @click="openGive"><Send class="size-4" />Give a task</button>
    </PageHeader>

    <div class="grid grid-cols-3 gap-3 mb-5 max-w-[560px]">
      <div class="card px-4 py-3 animate-in"><div class="text-[12px] text-subtle">Working now</div><div class="text-[22px] font-semibold tabular-nums flex items-center gap-2">{{ counts.running }}<Loader2 v-if="counts.running" class="size-4 animate-spin text-info" /></div></div>
      <div class="card px-4 py-3 animate-in" style="--i: 1"><div class="text-[12px] text-subtle">Done</div><div class="text-[22px] font-semibold tabular-nums">{{ counts.done }}</div></div>
      <div class="card px-4 py-3 animate-in" style="--i: 2"><div class="text-[12px] text-subtle">Failed</div><div class="text-[22px] font-semibold tabular-nums" :class="counts.failed ? 'text-bad' : ''">{{ counts.failed }}</div></div>
    </div>

    <div class="flex flex-wrap items-center gap-2 mb-4">
      <select v-model="agentFilter" class="input w-auto h-9">
        <option value="">All AI staff</option>
        <option v-for="a in agents" :key="a.agentId" :value="a.agentId">{{ a.avatar }} {{ a.name }}</option>
      </select>
      <div class="flex rounded-md border border-line-strong bg-surface p-0.5">
        <button v-for="s in [['', 'All'], ['running', 'Working'], ['completed', 'Done'], ['failed', 'Failed']]" :key="s[0]" class="h-7 px-2.5 rounded text-[12px] font-medium" :class="statusFilter === s[0] ? 'bg-brand-soft text-brand' : 'text-muted hover:text-ink'" data-no-loading @click="statusFilter = s[0]!">{{ s[1] }}</button>
      </div>
      <select v-model="sourceFilter" class="input w-auto h-9">
        <option value="">Given + scheduled</option>
        <option value="manual">Given by people</option>
        <option value="schedule">From schedules</option>
        <option value="followup">Follow-ups of problems</option>
        <option value="delegation">Parts of team work</option>
      </select>
      <label class="inline-flex items-center gap-2 text-[13px] ml-1"><input v-model="todayOnly" type="checkbox" class="size-4 accent-[var(--color-brand)]" />Today only</label>
    </div>

    <Skeleton v-if="loading" kind="list" :rows="6" />
    <div v-else-if="!tasks.length" class="card">
      <EmptyState :icon="ListTodo" title="No tasks yet" text="Press “Give a task” to send an AI employee off to work, or make a schedule so it works every day by itself." />
    </div>
    <ul v-else class="card divide-y divide-line">
      <li v-for="(t, i) in tasks" :key="t.taskId" class="animate-in" :style="{ '--i': Math.min(i, 12) }">
        <button class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 transition-colors" @click="openId = t.taskId">
          <AgentAvatar :avatar="byAgent.get(t.agentId)?.avatar ?? '🤖'" :color="byAgent.get(t.agentId)?.color ?? 'slate'" :size="34" :working="t.status === 'running'" />
          <span class="min-w-0 flex-1">
            <span class="block text-[13.5px] font-medium truncate">{{ t.title }}</span>
            <span class="block text-[12px] text-subtle truncate">
              {{ t.agentName }} ·
              <template v-if="t.source === 'schedule'"><CalendarClock class="size-3 inline -mt-0.5" /> schedule</template>
              <template v-else-if="t.source === 'followup'">follow-up of a problem</template>
              <template v-else-if="t.source === 'delegation'">part of team work</template>
              <template v-else>given by {{ t.createdBy === auth.profile?.uid ? 'you' : 'someone' }}</template>
              · {{ timeAgo(t.createdAt) }}<template v-if="t.priority === 'high'"> · <span class="text-warn">high priority</span></template>
            </span>
          </span>
          <span class="text-[12px] text-subtle tabular-nums hidden sm:block">{{ duration(t) }}</span>
          <span class="chip h-6 border-0 shrink-0 inline-flex items-center gap-1" :class="STATUS[t.status].cls">
            <Loader2 v-if="t.status === 'running'" class="size-3 animate-spin" />{{ STATUS[t.status].label }}
          </span>
        </button>
      </li>
    </ul>

    <!-- Task detail (slides in from the right) -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="opened" class="fixed inset-0 z-50 flex justify-end bg-black/25" @click.self="openId = null">
          <aside class="panel-slide w-full max-w-[640px] h-full bg-surface border-l border-line flex flex-col shadow-[var(--shadow-pop)]">
            <header class="p-4 border-b border-line flex items-start gap-3">
              <AgentAvatar :avatar="byAgent.get(opened.agentId)?.avatar ?? '🤖'" :color="byAgent.get(opened.agentId)?.color ?? 'slate'" :size="40" :working="opened.status === 'running'" />
              <div class="min-w-0 flex-1">
                <h2 class="font-semibold text-[15px]">{{ opened.title }}</h2>
                <p class="text-[12px] text-subtle">{{ opened.agentName }} · {{ new Date(opened.createdAt).toLocaleString() }}<template v-if="opened.attempt > 1"> · attempt {{ opened.attempt }}</template></p>
              </div>
              <span class="chip h-6 border-0" :class="STATUS[opened.status].cls">{{ STATUS[opened.status].label }}</span>
              <button class="btn-ghost btn-icon size-8" aria-label="Close" @click="openId = null"><X class="size-4" /></button>
            </header>
            <div class="flex-1 overflow-y-auto p-5 space-y-5 text-[13px]">
              <section>
                <h3 class="text-[11.5px] font-medium text-subtle uppercase tracking-wide mb-1.5">The task</h3>
                <p class="whitespace-pre-wrap">{{ opened.instructions }}</p>
              </section>
              <section v-if="opened.steps.length || opened.status === 'running'">
                <h3 class="text-[11.5px] font-medium text-subtle uppercase tracking-wide mb-1.5">What it did</h3>
                <ul class="space-y-1">
                  <li v-for="(s, i) in opened.steps" :key="i" class="flex items-start gap-2 animate-in">
                    <Loader2 v-if="s.status === 'running'" class="size-3.5 mt-0.5 animate-spin text-brand shrink-0" />
                    <Check v-else-if="s.status === 'done'" class="size-3.5 mt-0.5 text-ok shrink-0" />
                    <CircleX v-else class="size-3.5 mt-0.5 text-bad shrink-0" />
                    <span :class="s.status === 'error' ? 'text-bad' : 'text-muted'">{{ s.label }}<span v-if="s.detail" class="text-subtle"> — {{ s.detail }}</span></span>
                  </li>
                  <li v-if="opened.status === 'running'" class="flex items-center gap-2 text-muted"><span class="dots text-brand"><span /><span /><span /></span>Working</li>
                </ul>
              </section>
              <section v-if="opened.output">
                <div class="flex items-center justify-between mb-1.5">
                  <h3 class="text-[11.5px] font-medium text-subtle uppercase tracking-wide">Result</h3>
                  <button class="btn-ghost h-7 px-2 text-[12px]" @click="copy(opened.output!)"><ClipboardCopy class="size-3.5" />Copy</button>
                </div>
                <div class="md rounded-lg border border-line p-4" v-html="renderMarkdown(opened.output)" />
              </section>
              <section v-if="opened.files.length" class="flex flex-wrap gap-2">
                <button v-for="f in opened.files" :key="f.fileId" class="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[12.5px] hover:border-brand" @click="download(f)"><FileDown class="size-4 text-brand" />{{ f.name }}</button>
              </section>
              <section v-if="opened.issues?.length">
                <h3 class="text-[11.5px] font-medium text-subtle uppercase tracking-wide mb-1.5">Problems it reported</h3>
                <ul class="space-y-1">
                  <li v-for="iss in opened.issues" :key="iss.key" class="flex gap-2 rounded-md bg-warn-soft/50 px-3 py-1.5"><span class="text-warn">⚠</span>{{ iss.text }}</li>
                </ul>
                <RouterLink v-if="opened.responsibilityId" :to="{ path: '/ai-schedules', query: { tab: 'responsibilities', r: opened.responsibilityId } }" class="text-[12px] text-brand hover:underline mt-1.5 inline-block">See the responsibility →</RouterLink>
              </section>
              <p v-if="opened.parentTaskId && opened.source === 'followup'" class="text-[12px] text-muted">Follow-up of a problem found by <button class="text-brand hover:underline" @click="openId = opened.parentTaskId">this task</button>.</p>
              <p v-if="opened.source === 'delegation'" class="text-[12px] text-muted">A part of team work handed out by a manager AI. <RouterLink to="/ai-collaboration" class="text-brand hover:underline">See the whole plan</RouterLink></p>
              <div v-if="opened.status === 'waiting_approval' && opened.approvalId" class="rounded-lg bg-warn-soft p-3 flex items-center gap-3">
                <span class="flex-1">{{ opened.agentName }} is waiting for a person to approve its next step.</span>
                <RouterLink :to="{ path: '/ai-approvals', query: { id: opened.approvalId } }" class="btn-primary h-8">Review</RouterLink>
              </div>
              <p v-if="opened.error" class="rounded-lg bg-bad-soft text-bad p-3">{{ opened.error }}</p>
              <dl class="grid grid-cols-[120px_minmax(0,1fr)] gap-y-1 text-[12px] text-muted border-t border-line pt-4">
                <dt class="text-subtle">Started</dt><dd>{{ opened.startedAt ? new Date(opened.startedAt).toLocaleString() : 'Waiting in line' }}</dd>
                <dt class="text-subtle">Took</dt><dd class="flex items-center gap-1"><Clock class="size-3" />{{ duration(opened) || '—' }}</dd>
                <dt class="text-subtle">AI usage</dt><dd>{{ (opened.inputTokens + opened.outputTokens).toLocaleString() }} tokens</dd>
                <dt class="text-subtle">Started by</dt><dd>{{ opened.source === 'schedule' ? 'Its schedule' : opened.source === 'followup' ? 'A problem it found' : opened.source === 'delegation' ? 'A manager AI' : 'A person' }} · runs with {{ opened.runAsId === auth.profile?.uid ? 'your' : 'their' }} permissions</dd>
              </dl>
            </div>
            <footer class="p-3 border-t border-line flex gap-2 justify-end">
              <RouterLink :to="`/ai-staff/${opened.agentId}/chat`" class="btn-ghost mr-auto">Chat with {{ opened.agentName }}</RouterLink>
 <button v-if="opened.status === 'running' || opened.status === 'queued' || opened.status === 'waiting_approval'" class="btn-secondary" data-no-loading @click="cancel(opened)"><Square class="size-3.5 fill-current" />Stop</button>
              <button v-if="opened.status === 'failed' || opened.status === 'cancelled'" class="btn-primary" @click="retry(opened)"><RotateCcw class="size-4" />Run again</button>
            </footer>
          </aside>
        </div>
      </Transition>
    </Teleport>

    <Modal v-if="giving" title="Give a task" width="560px" @close="giving = false">
      <p class="text-[12.5px] text-muted -mt-1 mb-4">It works in the background with your permissions — you can close the app. The result appears here.</p>
      <form id="give-task" class="space-y-4" @submit.prevent="give">
        <div>
          <label class="label">Who</label>
          <select v-model="form.agentId" class="input" required>
            <option v-for="a in chatAgents" :key="a.agentId" :value="a.agentId">{{ a.avatar }} {{ a.name }} — {{ a.title }}</option>
          </select>
        </div>
        <div>
          <label class="label">The task</label>
          <textarea v-model="form.instructions" class="textarea" rows="5" maxlength="4000" required placeholder="e.g. List all unresolved issues older than 3 days, grouped by property, with who is handling each one." />
        </div>
        <div>
          <label class="label">Priority</label>
          <div class="flex gap-1.5">
            <button v-for="p in (['low', 'normal', 'high'] as const)" :key="p" type="button" class="chip h-8 px-3 capitalize" :class="form.priority === p ? 'bg-brand-soft text-brand border-brand' : ''" @click="form.priority = p">{{ p }}</button>
          </div>
        </div>
        <p class="text-[12px] text-subtle">If it needs to run a workflow or click something risky, it waits for approval on the Approvals page (you get a bell notice).</p>
      </form>
      <template #footer>
        <button class="btn-secondary" @click="giving = false">Cancel</button>
        <button class="btn-primary" type="submit" form="give-task" :disabled="!form.agentId || !form.instructions.trim()"><Send class="size-4" />Start</button>
      </template>
    </Modal>
  </div>
</template>
