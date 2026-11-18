<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Bot, ChevronDown, ChevronRight, History, LogIn, KeyRound, RefreshCw, Search, Settings, Users, Workflow, Activity, LayoutTemplate } from '@lucide/vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import JsonView from '@/components/ui/JsonView.vue';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';

/** "Who did what, when" — every important change is recorded by the server and can't be edited. */
interface Log {
  logId: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  timestamp: string;
  metadata: Record<string, unknown>;
}

const LABELS: Record<string, string> = {
  'auth.login': 'signed in',
  'workflow.create': 'created a workflow',
  'workflow.update': 'changed workflow details',
  'workflow.delete': 'deleted a workflow',
  'workflow.duplicate': 'duplicated a workflow',
  'workflow.publish': 'published a workflow',
  'workflow.activate': 'switched a workflow on',
  'workflow.deactivate': 'switched a workflow off',
  'workflow.import': 'imported a workflow',
  'workflow.export': 'exported a workflow',
  'workflow.share': 'changed who a workflow is shared with',
  'execution.cancel': 'stopped a run',
  'execution.retry': 'retried a run',
  'credential.create': 'added a connection',
  'credential.update': 'changed a connection',
  'credential.delete': 'removed a connection',
  'credential.rotate': 'replaced a connection’s secret',
  'webhook.rotate': 'made a new webhook address',
  'template.create': 'saved a template',
  'template.delete': 'deleted a template',
  'user.invite': 'invited a person',
  'user.update': 'changed a person’s access',
  'settings.update': 'changed system settings',
  'assistant.settings': 'changed Assistant settings',
  'system.backup': 'downloaded a backup',
  'agent.create': 'added an AI employee',
  'agent.update': 'changed an AI employee',
  'agent.enable': 'switched an AI employee on',
  'agent.disable': 'switched an AI employee off',
  'agent.archive': 'archived an AI employee',
  'agent.delete': 'deleted an AI employee',
  'memory.review': 'looked at an AI employee’s memory',
  'memory.edit': 'corrected someone’s AI memory',
  'memory.delete': 'deleted someone’s AI memory',
  'assistant.approve': 'approved an AI action',
  'agentTask.create': 'gave an AI employee a task',
  'agentSchedule.create': 'made an AI schedule',
  'agentSchedule.update': 'changed an AI schedule',
  'agentSchedule.delete': 'deleted an AI schedule',
  'approval.approve': 'approved an AI action',
  'approval.reject': 'rejected an AI action',
  'approval.edit': 'edited an AI action before approving',
  'approval.policy': 'changed the AI approval rules',
  'agentResponsibility.create': 'gave an AI employee a responsibility',
  'agentResponsibility.update': 'changed an AI responsibility',
  'agentResponsibility.delete': 'deleted an AI responsibility',
  'assistant.decline': 'declined an AI action',
};

const GROUPS = [
  { key: '', label: 'Everything', icon: Activity },
  { key: 'workflow', label: 'Workflows', icon: Workflow, match: (a: string) => a.startsWith('workflow.') || a.startsWith('execution.') || a.startsWith('webhook.') },
  { key: 'people', label: 'People', icon: Users, match: (a: string) => a.startsWith('user.') },
  { key: 'connections', label: 'Connections', icon: KeyRound, match: (a: string) => a.startsWith('credential.') },
  { key: 'ai', label: 'AI Staff', icon: Bot, match: (a: string) => a.startsWith('agent') || a.startsWith('memory.') || a.startsWith('assistant.') || a.startsWith('approval.') },
  { key: 'settings', label: 'Settings', icon: Settings, match: (a: string) => a.startsWith('settings.') || a.startsWith('system.') || a.startsWith('template.') },
  { key: 'login', label: 'Sign-ins', icon: LogIn, match: (a: string) => a === 'auth.login' },
] as const;

const logs = ref<Log[]>([]);
const cursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref<string | null>(null);
const group = ref('');
const q = ref('');
const open = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const res = await api<{ items: Log[]; nextCursor: string | null }>('/system/audit-logs');
    logs.value = res.items;
    cursor.value = res.nextCursor;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}
async function more() {
  if (!cursor.value) return;
  loadingMore.value = true;
  try {
    const res = await api<{ items: Log[]; nextCursor: string | null }>('/system/audit-logs', { query: { cursor: cursor.value } });
    logs.value.push(...res.items);
    cursor.value = res.nextCursor;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loadingMore.value = false;
  }
}
onMounted(load);

const label = (a: string) => LABELS[a] ?? a.replace('.', ' → ');
const iconFor = (a: string) => GROUPS.find((g) => 'match' in g && g.match(a))?.icon ?? History;
const who = (l: Log) => l.actorName ?? (l.actorId ? 'Someone (removed)' : 'The system');
/** A short, readable "what" for the row, from whatever the server recorded. */
function detail(l: Log): string {
  const m = l.metadata ?? {};
  if (l.action === 'workflow.share') {
    const a = (m.added as string[] | undefined)?.length ?? 0;
    const r = (m.removed as string[] | undefined)?.length ?? 0;
    return [a && `${a} added`, r && `${r} removed`].filter(Boolean).join(', ');
  }
  if (typeof m.name === 'string') return m.name;
  if (typeof m.email === 'string') return m.email;
  if (l.action === 'workflow.update' && Array.isArray(m.fields)) return `changed: ${(m.fields as string[]).join(', ')}`;
  if (l.action === 'user.update') return Object.entries(m).map(([k, v]) => `${k} → ${v}`).join(', ');
  return '';
}
const link = (l: Log) =>
  l.resourceId && l.action !== 'workflow.delete' && l.action !== 'agent.delete'
    ? l.resourceType === 'workflow'
      ? `/workflows/${l.resourceId}/edit`
      : l.resourceType === 'execution'
        ? `/executions/${l.resourceId}`
        : l.resourceType === 'agent'
          ? `/ai-staff/${l.resourceId}/edit`
          : null
    : null;

const shown = computed(() => {
  const g = GROUPS.find((x) => x.key === group.value);
  const s = q.value.trim().toLowerCase();
  return logs.value.filter((l) => (!g || !('match' in g) || g.match(l.action)) && (!s || `${who(l)} ${l.actorEmail ?? ''} ${label(l.action)} ${detail(l)}`.toLowerCase().includes(s)));
});

/** Group rows under "Today", "Yesterday", or a date. */
const sections = computed(() => {
  const out: { day: string; rows: Log[] }[] = [];
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400_000).toDateString();
  for (const l of shown.value) {
    const d = new Date(l.timestamp);
    const key = d.toDateString() === today ? 'Today' : d.toDateString() === yesterday ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const last = out[out.length - 1];
    if (last?.day === key) last.rows.push(l);
    else out.push({ day: key, rows: [l] });
  }
  return out;
});
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1080px] mx-auto">
    <PageHeader title="Activity log" subtitle="Who changed what, and when. Entries can’t be edited or deleted.">
      <button class="btn-secondary" data-no-loading @click="load"><RefreshCw class="size-4" :class="{ 'animate-spin': loading }" />Refresh</button>
    </PageHeader>

    <div class="flex flex-wrap items-center gap-2 mb-4">
      <div class="flex flex-wrap rounded-md border border-line-strong bg-surface p-0.5">
        <button
          v-for="g in GROUPS"
          :key="g.key"
          class="h-7 px-2.5 rounded text-[12px] font-medium inline-flex items-center gap-1.5"
          :class="group === g.key ? 'bg-brand-soft text-brand' : 'text-muted hover:text-ink'"
          data-no-loading
          @click="group = g.key"
        >
          <component :is="g.icon" class="size-3.5" />{{ g.label }}
        </button>
      </div>
      <div class="relative ml-auto w-full sm:w-[240px]">
        <Search class="size-4 text-subtle absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input v-model="q" class="input pl-8" placeholder="Search name or action…" />
      </div>
    </div>

    <p v-if="error" class="card p-4 text-bad text-[13px] mb-4">{{ error }}</p>
    <Skeleton v-if="loading && !logs.length" kind="list" :rows="8" />
    <div v-else-if="!shown.length" class="card">
      <EmptyState :icon="History" title="Nothing here" :text="logs.length ? 'No entries match this filter. Try “Everything” or clear the search.' : 'Changes people make will be listed here.'" />
    </div>

    <div v-else class="space-y-5">
      <section v-for="s in sections" :key="s.day">
        <h2 class="text-[12px] font-medium text-subtle mb-2">{{ s.day }}</h2>
        <ul class="card divide-y divide-line">
          <li v-for="(l, idx) in s.rows" :key="l.logId" class="animate-in" :style="{ '--i': Math.min(idx, 12) }">
            <button class="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2 transition-colors" @click="open = open === l.logId ? null : l.logId">
              <span class="size-7 rounded-md bg-surface-2 grid place-items-center shrink-0"><component :is="iconFor(l.action)" class="size-3.5 text-muted" /></span>
              <span class="min-w-0 flex-1 text-[13px]">
                <b class="font-medium">{{ who(l) }}</b> {{ label(l.action) }}
                <span v-if="detail(l)" class="text-muted"> · {{ detail(l) }}</span>
              </span>
              <span class="text-[12px] text-subtle tabular-nums shrink-0" :title="new Date(l.timestamp).toLocaleString()">{{ time(l.timestamp) }}</span>
              <component :is="open === l.logId ? ChevronDown : ChevronRight" class="size-4 text-subtle shrink-0" />
            </button>
            <div v-if="open === l.logId" class="px-4 pb-3 pl-14 text-[12px] space-y-2">
              <dl class="grid grid-cols-[110px_minmax(0,1fr)] gap-y-1">
                <dt class="text-subtle">When</dt><dd>{{ new Date(l.timestamp).toLocaleString() }} ({{ timeAgo(l.timestamp) }})</dd>
                <dt class="text-subtle">Who</dt><dd>{{ who(l) }}<span v-if="l.actorEmail" class="text-muted"> · {{ l.actorEmail }}</span></dd>
                <dt class="text-subtle">What</dt><dd><code>{{ l.action }}</code> on {{ l.resourceType }} <code v-if="l.resourceId">{{ l.resourceId }}</code></dd>
              </dl>
              <RouterLink v-if="link(l)" :to="link(l)!" class="text-brand hover:underline inline-block">Open it →</RouterLink>
              <JsonView v-if="Object.keys(l.metadata ?? {}).length" :value="l.metadata" />
            </div>
          </li>
        </ul>
      </section>
      <div class="text-center">
        <button v-if="cursor" class="btn-secondary" :disabled="loadingMore" @click="more">Show older entries</button>
        <p v-else class="text-[12px] text-subtle">That’s everything.</p>
      </div>
    </div>
  </div>
</template>
