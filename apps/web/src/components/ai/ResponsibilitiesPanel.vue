<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { AlertTriangle, Check, ChevronDown, ChevronRight, ClipboardList, Pause, Pencil, Play, Plus, Trash2 } from '@lucide/vue';
import type { AgentResponsibilityView, AgentScheduleView, AgentSummary } from '@widebed/shared';
import Modal from '@/components/ui/Modal.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AgentAvatar from '@/components/ai/AgentAvatar.vue';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';

/**
 * Long-term duties of AI staff ("Monitor outstanding utility bills"). Each one is carried out
 * by schedules; problems found stay on the list until a later run no longer reports them.
 */
const props = defineProps<{ agents: AgentSummary[]; schedules: AgentScheduleView[] }>();
const emit = defineEmits<{ changed: [] }>();
const route = useRoute();

const items = ref<AgentResponsibilityView[]>([]);
const loading = ref(true);
const showResolved = ref<string | null>(null);
const highlight = ref<string | null>(typeof route.query.r === 'string' ? route.query.r : null);

async function load() {
  try {
    items.value = (await api<{ items: AgentResponsibilityView[] }>('/agent-responsibilities')).items;
  } catch (err) {
    toastError(err);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const editable = computed(() => props.agents.filter((a) => a.canEdit && a.status !== 'archived'));
const days = (iso: string) => {
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86400_000);
  return d <= 0 ? 'today' : d === 1 ? '1 day' : `${d} days`;
};

/* ---------- editor ---------- */
interface Form {
  responsibilityId: string | null;
  agentId: string;
  title: string;
  description: string;
  status: 'active' | 'paused';
  autoFollowUp: boolean;
  scheduleIds: string[];
}
const editing = ref<Form | null>(null);
const agentSchedules = computed(() => props.schedules.filter((s) => s.agentId === editing.value?.agentId));
watch(
  () => editing.value?.agentId,
  (now, before) => {
    if (editing.value && before && now !== before) editing.value.scheduleIds = [];
  },
);
function openNew() {
  editing.value = { responsibilityId: null, agentId: editable.value[0]?.agentId ?? '', title: '', description: '', status: 'active', autoFollowUp: true, scheduleIds: [] };
}
function edit(r: AgentResponsibilityView) {
  editing.value = { responsibilityId: r.responsibilityId, agentId: r.agentId, title: r.title, description: r.description, status: r.status, autoFollowUp: r.autoFollowUp, scheduleIds: r.schedules.map((s) => s.scheduleId) };
}
async function save() {
  if (!editing.value) return;
  const { responsibilityId, ...body } = editing.value;
  try {
    if (responsibilityId) await api(`/agent-responsibilities/${responsibilityId}`, { method: 'PUT', body });
    else await api('/agent-responsibilities', { method: 'POST', body });
    toast(responsibilityId ? 'Saved' : 'Responsibility added', 'success');
    editing.value = null;
    await load();
    emit('changed');
  } catch (err) {
    toastError(err);
  }
}
async function setStatus(r: AgentResponsibilityView, status: 'active' | 'paused') {
  try {
    await api(`/agent-responsibilities/${r.responsibilityId}`, { method: 'PUT', body: { agentId: r.agentId, title: r.title, description: r.description, status, autoFollowUp: r.autoFollowUp, scheduleIds: r.schedules.map((s) => s.scheduleId) } });
    toast(status === 'paused' ? 'Paused — its schedules wait until you resume' : 'Resumed', 'success');
    load();
  } catch (err) {
    toastError(err);
  }
}
async function remove(r: AgentResponsibilityView) {
  if (!confirm(`Delete the responsibility “${r.title}”? Its schedules stay, but stop tracking problems.`)) return;
  try {
    await api(`/agent-responsibilities/${r.responsibilityId}`, { method: 'DELETE' });
    items.value = items.value.filter((x) => x.responsibilityId !== r.responsibilityId);
    emit('changed');
  } catch (err) {
    toastError(err);
  }
}
async function resolve(r: AgentResponsibilityView, key: string) {
  try {
    await api(`/agent-responsibilities/${r.responsibilityId}/issues/${encodeURIComponent(key)}/resolve`, { method: 'POST' });
    const i = r.openIssues.findIndex((x) => x.key === key);
    if (i >= 0) r.resolvedIssues.unshift({ ...r.openIssues.splice(i, 1)[0]!, resolvedAt: new Date().toISOString() });
  } catch (err) {
    toastError(err);
  }
}
</script>

<template>
  <div>
    <div class="flex items-start justify-between gap-4 mb-4">
      <p class="text-[13px] text-muted max-w-[640px]">
        A responsibility is a permanent duty, like <i>“Monitor outstanding utility bills”</i>. Link it to schedules: each run reports the problems it finds, which stay listed here until a later run no longer finds them.
      </p>
      <button v-if="editable.length" class="btn-primary shrink-0" @click="openNew"><Plus class="size-4" />New responsibility</button>
    </div>

    <Skeleton v-if="loading" kind="list" :rows="3" />
    <div v-else-if="!items.length" class="card">
      <EmptyState :icon="ClipboardList" title="No responsibilities yet" text="Example: Finance Assistant — “Monitor outstanding utility bills”, carried out by its 8:00 AM schedule." />
    </div>

    <div v-else class="space-y-4">
      <article
        v-for="(r, i) in items"
        :key="r.responsibilityId"
        class="card p-4 animate-in transition-shadow"
        :class="highlight === r.responsibilityId ? 'ring-2 ring-brand' : ''"
        :style="{ '--i': i }"
      >
        <div class="flex items-start gap-3">
          <AgentAvatar :avatar="r.agentAvatar" :color="r.agentColor" :size="36" :muted="r.status === 'paused'" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <h3 class="font-semibold text-[14px]">{{ r.title }}</h3>
              <span class="chip h-5 text-[11px] border-0" :class="r.status === 'active' ? 'bg-ok-soft text-ok' : 'bg-surface-2 text-subtle'">{{ r.status === 'active' ? 'Active' : 'Paused' }}</span>
              <span v-if="r.openIssues.length" class="chip h-5 text-[11px] border-0 bg-warn-soft text-warn">{{ r.openIssues.length }} open {{ r.openIssues.length === 1 ? 'problem' : 'problems' }}</span>
            </div>
            <p class="text-[12.5px] text-muted">{{ r.agentName }}<template v-if="r.description"> · {{ r.description }}</template></p>
            <p class="text-[12px] text-subtle mt-1">
              <template v-if="r.schedules.length">Done by: {{ r.schedules.map((s) => `${s.name} (${s.describe.toLowerCase()})`).join(', ') }}</template>
              <span v-else class="text-warn">No schedule linked yet — edit it and pick one.</span>
              <template v-if="r.lastRunAt"> · {{ r.runs }} {{ r.runs === 1 ? 'run' : 'runs' }}, last <RouterLink v-if="r.lastTaskId" :to="{ path: '/ai-tasks', query: { task: r.lastTaskId } }" class="text-brand hover:underline">{{ timeAgo(r.lastRunAt) }}</RouterLink></template>
              <template v-if="r.autoFollowUp"> · follow-up tasks on</template>
            </p>
          </div>
          <div v-if="r.canEdit" class="flex gap-0.5 shrink-0">
            <button v-if="r.status === 'active'" class="btn-ghost btn-icon size-8" title="Pause" @click="setStatus(r, 'paused')"><Pause class="size-4" /></button>
            <button v-else class="btn-ghost btn-icon size-8" title="Resume" @click="setStatus(r, 'active')"><Play class="size-4" /></button>
            <button class="btn-ghost btn-icon size-8" title="Edit" @click="edit(r)"><Pencil class="size-4" /></button>
            <button class="btn-ghost btn-icon size-8" title="Delete" @click="remove(r)"><Trash2 class="size-4" /></button>
          </div>
        </div>

        <ul v-if="r.openIssues.length" class="mt-3 space-y-1.5">
          <li v-for="iss in r.openIssues" :key="iss.key" class="flex items-start gap-2.5 rounded-lg bg-warn-soft/50 border border-warn/20 px-3 py-2 text-[13px] animate-in">
            <AlertTriangle class="size-4 text-warn shrink-0 mt-0.5" />
            <div class="min-w-0 flex-1">
              <div>{{ iss.text }}</div>
              <div class="text-[11.5px] text-subtle">
                Open {{ days(iss.firstSeenAt) }} · seen in {{ iss.seenCount }} {{ iss.seenCount === 1 ? 'run' : 'runs' }}
                <template v-if="iss.followUpTaskId"> · <RouterLink :to="{ path: '/ai-tasks', query: { task: iss.followUpTaskId } }" class="text-brand hover:underline">follow-up task</RouterLink></template>
              </div>
            </div>
            <button v-if="r.canEdit" class="btn-ghost h-7 px-2 text-[12px] shrink-0" title="Mark as sorted" @click="resolve(r, iss.key)"><Check class="size-3.5" />Sorted</button>
          </li>
        </ul>
        <p v-else-if="r.runs" class="mt-3 text-[12.5px] text-ok flex items-center gap-1.5"><Check class="size-3.5" />No open problems in the last run.</p>

        <div v-if="r.resolvedIssues.length" class="mt-2">
          <button class="text-[12px] text-subtle hover:text-ink inline-flex items-center gap-1" data-no-loading @click="showResolved = showResolved === r.responsibilityId ? null : r.responsibilityId">
            <component :is="showResolved === r.responsibilityId ? ChevronDown : ChevronRight" class="size-3.5" />{{ r.resolvedIssues.length }} recently solved
          </button>
          <ul v-if="showResolved === r.responsibilityId" class="mt-1.5 space-y-1 text-[12.5px] text-muted pl-5">
            <li v-for="iss in r.resolvedIssues" :key="`${iss.key}-${iss.resolvedAt}`" class="animate-in"><span class="line-through decoration-subtle/50">{{ iss.text }}</span> <span class="text-subtle">· solved {{ iss.resolvedAt ? timeAgo(iss.resolvedAt) : '' }}</span></li>
          </ul>
        </div>
      </article>
    </div>

    <Modal v-if="editing" :title="editing.responsibilityId ? 'Edit responsibility' : 'New responsibility'" width="580px" @close="editing = null">
      <form id="resp-form" class="space-y-4" @submit.prevent="save">
        <div>
          <label class="label">AI employee</label>
          <select v-model="editing.agentId" class="input" :disabled="!!editing.responsibilityId" required>
            <option v-for="a in editable" :key="a.agentId" :value="a.agentId">{{ a.avatar }} {{ a.name }}</option>
          </select>
        </div>
        <div><label class="label">Responsibility</label><input v-model="editing.title" class="input" maxlength="120" required placeholder="e.g. Monitor outstanding utility bills" /></div>
        <div><label class="label">What “good” looks like (optional)</label><textarea v-model="editing.description" class="textarea" rows="2" maxlength="2000" placeholder="e.g. Every bill is paid before its due date." /></div>
        <div>
          <label class="label">Carried out by these schedules</label>
          <div v-if="agentSchedules.length" class="space-y-1.5">
            <label v-for="s in agentSchedules" :key="s.scheduleId" class="flex items-center gap-2 text-[13px] rounded-md border border-line px-3 py-2 cursor-pointer hover:border-line-strong">
              <input v-model="editing.scheduleIds" type="checkbox" :value="s.scheduleId" class="size-4 accent-[var(--color-brand)]" />
              <span class="flex-1">{{ s.name }} <span class="text-subtle">· {{ s.describe }}</span></span>
              <span v-if="s.responsibilityId && s.responsibilityId !== editing.responsibilityId" class="text-[11px] text-warn">moves here</span>
            </label>
          </div>
          <p v-else class="text-[12.5px] text-subtle">This AI employee has no schedules yet. Make one on the Schedules tab first.</p>
        </div>
        <label class="flex items-start gap-2 text-[13px]">
          <input v-model="editing.autoFollowUp" type="checkbox" class="size-4 mt-0.5 accent-[var(--color-brand)]" />
          <span>Give it a <b>follow-up task</b> for each new problem (once per problem, never repeated while the problem stays open)</span>
        </label>
        <label class="flex items-center gap-2 text-[13px]"><input :checked="editing.status === 'active'" type="checkbox" class="size-4 accent-[var(--color-brand)]" @change="editing.status = ($event.target as HTMLInputElement).checked ? 'active' : 'paused'" />Active</label>
      </form>
      <template #footer>
        <button class="btn-secondary" @click="editing = null">Cancel</button>
        <button class="btn-primary" type="submit" form="resp-form" :disabled="!editing.agentId || !editing.title.trim()">{{ editing.responsibilityId ? 'Save' : 'Add responsibility' }}</button>
      </template>
    </Modal>
  </div>
</template>
