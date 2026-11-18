<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { CalendarClock, ListTodo, Pencil, Play, Plus, Trash2 } from '@lucide/vue';
import { DEFAULT_SCHEDULE_RULE, SCHEDULE_IDEAS, type AgentScheduleRule, type AgentScheduleView, type AgentSummary, type AgentTaskPriority, type AiAgent } from '@widebed/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import Modal from '@/components/ui/Modal.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AgentAvatar from '@/components/ai/AgentAvatar.vue';
import ScheduleRuleEditor from '@/components/ai/ScheduleRuleEditor.vue';
import ResponsibilitiesPanel from '@/components/ai/ResponsibilitiesPanel.vue';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';

/** AI Staff Schedules: work an AI employee does by itself, every day/week/month. Runs on the server. */
const router = useRouter();
const route = useRoute();
const tab = ref<'schedules' | 'responsibilities'>(route.query.tab === 'responsibilities' ? 'responsibilities' : 'schedules');
function setTab(t: 'schedules' | 'responsibilities') {
  tab.value = t;
  router.replace({ query: { ...route.query, tab: t === 'schedules' ? undefined : t } });
}
const schedules = ref<AgentScheduleView[]>([]);
const agents = ref<AgentSummary[]>([]);
const templates = ref<Map<string, string | null>>(new Map());
const loading = ref(true);

async function load() {
  try {
    const [s, a] = await Promise.all([api<{ items: AgentScheduleView[] }>('/agent-schedules'), api<{ items: AgentSummary[] }>('/agents', { quiet: true })]);
    schedules.value = s.items;
    agents.value = a.items;
  } catch (err) {
    toastError(err);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const editable = computed(() => agents.value.filter((a) => a.canEdit && a.status !== 'archived'));
const groups = computed(() => {
  const m = new Map<string, { agentId: string; name: string; avatar: string; color: string; items: AgentScheduleView[] }>();
  for (const s of [...schedules.value].sort((a, b) => (a.rule.time ?? '').localeCompare(b.rule.time ?? ''))) {
    if (!m.has(s.agentId)) m.set(s.agentId, { agentId: s.agentId, name: s.agentName, avatar: s.agentAvatar, color: s.agentColor, items: [] });
    m.get(s.agentId)!.items.push(s);
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
});
const STATUS: Record<string, string> = { completed: 'text-ok', failed: 'text-bad', running: 'text-info', queued: 'text-muted', cancelled: 'text-subtle' };
const STATUS_LABEL: Record<string, string> = { completed: 'done', failed: 'failed', running: 'working', queued: 'waiting', cancelled: 'cancelled' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');

/* ---------- editor ---------- */
interface Form {
  scheduleId: string | null;
  name: string;
  agentId: string;
  instructions: string;
  rule: AgentScheduleRule;
  startDate: string | null;
  endDate: string | null;
  priority: AgentTaskPriority;
  enabled: boolean;
  notify: 'failures' | 'always' | 'off';
}
const editing = ref<Form | null>(null);
const saving = ref(false);
function blank(agentId = ''): Form {
  return { scheduleId: null, name: '', agentId: agentId || editable.value[0]?.agentId || '', instructions: '', rule: { ...DEFAULT_SCHEDULE_RULE, weekdays: ['1'] }, startDate: null, endDate: null, priority: 'normal', enabled: true, notify: 'failures' };
}
function edit(s: AgentScheduleView) {
  editing.value = { scheduleId: s.scheduleId, name: s.name, agentId: s.agentId, instructions: s.instructions, rule: { ...DEFAULT_SCHEDULE_RULE, ...s.rule }, startDate: s.startDate, endDate: s.endDate, priority: s.priority, enabled: s.enabled, notify: s.notify ?? 'failures' };
}
/** Ideas fitting the chosen AI employee (by the template it was made from). */
async function templateOf(agentId: string) {
  if (!templates.value.has(agentId)) {
    try {
      const res = await api<{ agent?: AiAgent }>(`/agents/${agentId}`, { quiet: true });
      templates.value.set(agentId, res.agent?.templateId ?? null);
    } catch {
      templates.value.set(agentId, null);
    }
  }
  return templates.value.get(agentId) ?? null;
}
const ideas = ref<typeof SCHEDULE_IDEAS>([]);
async function refreshIdeas() {
  if (!editing.value || editing.value.scheduleId) return (ideas.value = []);
  const t = await templateOf(editing.value.agentId);
  ideas.value = SCHEDULE_IDEAS.filter((i) => !t || i.templateId === t).slice(0, 4);
}
function useIdea(i: (typeof SCHEDULE_IDEAS)[number]) {
  if (!editing.value) return;
  editing.value.name = i.name;
  editing.value.instructions = i.instructions;
  editing.value.rule = { ...editing.value.rule, mode: 'daily', time: i.time };
}
function openNew(agentId = '') {
  editing.value = blank(agentId);
  refreshIdeas();
}
async function save() {
  if (!editing.value) return;
  saving.value = true;
  const { scheduleId, ...body } = editing.value;
  try {
    if (scheduleId) await api(`/agent-schedules/${scheduleId}`, { method: 'PUT', body });
    else await api('/agent-schedules', { method: 'POST', body });
    toast(scheduleId ? 'Schedule saved' : 'Schedule created — it runs on the server, even when nobody is signed in', 'success');
    editing.value = null;
    load();
  } catch (err) {
    toastError(err);
  } finally {
    saving.value = false;
  }
}
async function toggle(s: AgentScheduleView) {
  const { scheduleId, name, agentId, instructions, rule, startDate, endDate, priority, notify } = s;
  try {
    await api(`/agent-schedules/${scheduleId}`, { method: 'PUT', body: { name, agentId, instructions, rule, startDate, endDate, priority, notify, enabled: !s.enabled } });
    load();
  } catch (err) {
    toastError(err);
  }
}
async function runNow(s: AgentScheduleView) {
  try {
    const t = await api<{ taskId: string }>(`/agent-schedules/${s.scheduleId}/run`, { method: 'POST' });
    toast(`${s.agentName} started “${s.name}”`, 'success');
    router.push({ path: '/ai-tasks', query: { task: t.taskId } });
  } catch (err) {
    toastError(err);
  }
}
async function remove(s: AgentScheduleView) {
  if (!confirm(`Delete the schedule “${s.name}”? Tasks it already ran stay in AI Tasks.`)) return;
  try {
    await api(`/agent-schedules/${s.scheduleId}`, { method: 'DELETE' });
    schedules.value = schedules.value.filter((x) => x.scheduleId !== s.scheduleId);
  } catch (err) {
    toastError(err);
  }
}
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1120px] mx-auto">
    <PageHeader title="AI Schedules" subtitle="Daily, weekly or monthly work your AI staff do by themselves, and the long-term responsibilities it serves. Runs on the server — no browser needs to be open.">
      <RouterLink to="/ai-tasks" class="btn-secondary"><ListTodo class="size-4" />AI Tasks</RouterLink>
      <button v-if="editable.length" class="btn-primary" @click="openNew()"><Plus class="size-4" />New schedule</button>
    </PageHeader>

    <div class="flex gap-1 border-b border-line mb-5">
      <button
        v-for="t in ([['schedules', 'Schedules'], ['responsibilities', 'Responsibilities']] as const)"
        :key="t[0]"
        class="h-9 px-3 text-[13px] font-medium border-b-2 -mb-px transition-colors"
        :class="tab === t[0] ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-ink'"
        data-no-loading
        @click="setTab(t[0])"
      >
        {{ t[1] }}
      </button>
    </div>

    <ResponsibilitiesPanel v-if="tab === 'responsibilities' && !loading" :agents="agents" :schedules="schedules" @changed="load" />

    <template v-if="tab === 'schedules'">
    <Skeleton v-if="loading" kind="list" :rows="5" />
    <div v-else-if="!schedules.length" class="card">
      <EmptyState :icon="CalendarClock" title="No schedules yet" :text="editable.length ? 'Press “New schedule”, e.g. “PMS Assistant: every day at 7:00 AM, list today’s arrivals”.' : 'Admins and the managers of an AI employee can give it a schedule.'" />
    </div>

    <div v-else class="space-y-5">
      <section v-for="(g, gi) in groups" :key="g.agentId" class="animate-in" :style="{ '--i': gi }">
        <div class="flex items-center gap-2.5 mb-2">
          <AgentAvatar :avatar="g.avatar" :color="g.color" :size="30" />
          <h2 class="font-semibold text-[14px]">{{ g.name }}</h2>
          <span class="text-[12px] text-subtle">{{ g.items.length }} {{ g.items.length === 1 ? 'schedule' : 'schedules' }}</span>
          <button v-if="g.items[0]?.canEdit" class="btn-ghost h-7 text-[12px] ml-auto" @click="openNew(g.agentId)"><Plus class="size-3.5" />Add</button>
        </div>
        <ul class="card divide-y divide-line">
          <li v-for="s in g.items" :key="s.scheduleId" class="flex items-center gap-3 px-4 py-3" :class="{ 'opacity-60': !s.enabled }">
            <div class="w-[78px] shrink-0 text-center">
              <div class="text-[15px] font-semibold tabular-nums">{{ s.rule.mode === 'interval' ? '⟳' : s.rule.time }}</div>
              <div class="text-[10.5px] text-subtle uppercase">{{ s.rule.mode === 'daily' ? 'daily' : s.rule.mode === 'weekly' ? 'weekly' : s.rule.mode === 'monthly' ? 'monthly' : s.rule.mode === 'once' ? 'once' : 'repeat' }}</div>
            </div>
            <div class="min-w-0 flex-1">
              <div class="text-[13.5px] font-medium truncate">{{ s.name }}<span v-if="s.responsibilityId" class="chip h-5 text-[10.5px] ml-1.5 align-middle">responsibility</span></div>
              <div class="text-[12px] text-muted truncate">{{ s.describe }}</div>
              <div class="text-[11.5px] text-subtle mt-0.5">
                <template v-if="s.enabled && s.nextRunAt">Next: {{ when(s.nextRunAt) }}</template>
                <template v-else-if="!s.enabled">Paused</template>
                <template v-if="s.lastRunAt">
                  · Last: {{ timeAgo(s.lastRunAt) }}
                  <RouterLink v-if="s.lastTaskId" :to="{ path: '/ai-tasks', query: { task: s.lastTaskId } }" :class="STATUS[s.lastStatus ?? ''] ?? ''" class="hover:underline">({{ STATUS_LABEL[s.lastStatus ?? ''] ?? s.lastStatus }})</RouterLink>
                </template>
              </div>
            </div>
            <template v-if="s.canEdit">
              <label class="inline-flex items-center cursor-pointer" :title="s.enabled ? 'On — click to pause' : 'Paused — click to switch on'">
                <input type="checkbox" class="sr-only peer" :checked="s.enabled" @change="toggle(s)" />
                <span class="w-9 h-5 rounded-full bg-line-strong peer-checked:bg-brand relative transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4" />
              </label>
              <button class="btn-ghost btn-icon size-8" title="Run now" @click="runNow(s)"><Play class="size-4" /></button>
              <button class="btn-ghost btn-icon size-8" title="Edit" @click="edit(s)"><Pencil class="size-4" /></button>
              <button class="btn-ghost btn-icon size-8" title="Delete" @click="remove(s)"><Trash2 class="size-4" /></button>
            </template>
          </li>
        </ul>
      </section>
    </div>
    </template>

    <Modal v-if="editing" :title="editing.scheduleId ? 'Edit schedule' : 'New schedule'" width="620px" @close="editing = null">
      <form id="sched-form" class="space-y-4" @submit.prevent="save">
        <div class="grid sm:grid-cols-2 gap-3">
          <div>
            <label class="label">AI employee</label>
            <select v-model="editing.agentId" class="input" required @change="refreshIdeas">
              <option v-for="a in editable" :key="a.agentId" :value="a.agentId">{{ a.avatar }} {{ a.name }}</option>
            </select>
          </div>
          <div><label class="label">Name</label><input v-model="editing.name" class="input" maxlength="80" required placeholder="e.g. Today’s arrivals" /></div>
        </div>
        <div v-if="ideas.length" class="flex flex-wrap gap-1.5">
          <span class="text-[12px] text-subtle self-center">Ideas:</span>
          <button v-for="i in ideas" :key="i.name" type="button" class="chip h-7 px-2.5 hover:border-brand hover:text-brand" @click="useIdea(i)">{{ i.time }} · {{ i.name }}</button>
        </div>
        <div>
          <label class="label">What to do each time</label>
          <textarea v-model="editing.instructions" class="textarea" rows="4" maxlength="4000" required placeholder="e.g. List every guest arriving today with unit and check-in time. Flag missing details." />
        </div>
        <ScheduleRuleEditor v-model="editing.rule" />
        <div class="grid sm:grid-cols-3 gap-3">
          <div><label class="label">From (optional)</label><input v-model="editing.startDate" type="date" class="input" /></div>
          <div><label class="label">Until (optional)</label><input v-model="editing.endDate" type="date" class="input" /></div>
          <div>
            <label class="label">Priority</label>
            <select v-model="editing.priority" class="input"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
          <label class="flex items-center gap-2 text-[13px]"><input v-model="editing.enabled" type="checkbox" class="size-4 accent-[var(--color-brand)]" />Switched on</label>
          <label class="flex items-center gap-2 text-[13px]">
            Tell me
            <select v-model="editing.notify" class="input h-8 w-auto">
              <option value="failures">only when it fails</option>
              <option value="always">after every run</option>
              <option value="off">never</option>
            </select>
          </label>
        </div>
        <p class="text-[12px] text-subtle">It runs with your permissions. If the AI service is busy it tries once more. Risky actions (running workflows, clicking “Pay”) wait for approval on the Approvals page.</p>
      </form>
      <template #footer>
        <button class="btn-secondary" @click="editing = null">Cancel</button>
        <button class="btn-primary" type="submit" form="sched-form" :disabled="saving">{{ editing.scheduleId ? 'Save' : 'Create schedule' }}</button>
      </template>
    </Modal>
  </div>
</template>
