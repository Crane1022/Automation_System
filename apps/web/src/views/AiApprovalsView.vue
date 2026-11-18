<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Check, Clock, Pencil, ShieldCheck, X } from '@lucide/vue';
import { CRITICAL_CONFIRM_WORD, LOW_RISK_POLICY_LABELS, RISK_LEVELS, type AgentApprovalView, type LowRiskPolicy, type RiskLevel } from '@widebed/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import Modal from '@/components/ui/Modal.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AgentAvatar from '@/components/ai/AgentAvatar.vue';
import RiskBadge from '@/components/ai/RiskBadge.vue';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useAuthStore } from '@/stores/auth';

/** Approval Center: what AI staff want to do, waiting for a person's decision. */
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const tab = ref<'pending' | 'history'>(route.query.tab === 'history' ? 'history' : 'pending');
const items = ref<AgentApprovalView[]>([]);
const loading = ref(true);
const focus = ref<string | null>(typeof route.query.id === 'string' ? route.query.id : null);
const isAdmin = computed(() => auth.can('agent.manage'));

async function load(quiet = false) {
  try {
    items.value = (await api<{ items: AgentApprovalView[] }>('/approvals', { query: { status: tab.value }, quiet })).items;
    // A link to a decided request opens History.
    if (focus.value && tab.value === 'pending' && !items.value.some((a) => a.approvalId === focus.value) && !quiet) {
      tab.value = 'history';
      return;
    }
  } catch (err) {
    if (!quiet) toastError(err);
  } finally {
    loading.value = false;
  }
}
watch(tab, (t) => {
  router.replace({ query: { ...route.query, tab: t === 'pending' ? undefined : t } });
  loading.value = true;
  load();
});
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  load();
  loadPolicy();
  timer = setInterval(() => tab.value === 'pending' && load(true), 15_000);
});
onBeforeUnmount(() => timer && clearInterval(timer));

const left = (iso: string) => {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h ? `${h} h ${m} min left` : `${m} min left`;
};
const STATUS: Record<string, { label: string; cls: string }> = {
  approved: { label: 'Approved', cls: 'bg-ok-soft text-ok' },
  rejected: { label: 'Not approved', cls: 'bg-bad-soft text-bad' },
  expired: { label: 'Expired', cls: 'bg-surface-2 text-subtle' },
  replaced: { label: 'Edited', cls: 'bg-info-soft text-info' },
  pending: { label: 'Waiting', cls: 'bg-warn-soft text-warn' },
};
const params = (input: unknown) => Object.entries((input ?? {}) as Record<string, unknown>);
const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/* ---------- decide ---------- */
const deciding = ref<{ a: AgentApprovalView; approve: boolean } | null>(null);
const note = ref('');
const word = ref('');
const busy = ref(false);
function ask(a: AgentApprovalView, approve: boolean) {
  deciding.value = { a, approve };
  note.value = '';
  word.value = '';
}
async function decide() {
  if (!deciding.value) return;
  const { a, approve } = deciding.value;
  busy.value = true;
  try {
    await api(`/approvals/${a.approvalId}/decide`, { method: 'POST', body: { approve, note: note.value || undefined, confirmWord: word.value || undefined } });
    toast(approve ? `Approved — ${a.agentName} carries on` : `Not approved — ${a.agentName} is told`, 'success');
    deciding.value = null;
    load(true);
  } catch (err) {
    toastError(err);
  } finally {
    busy.value = false;
  }
}

/* ---------- edit ---------- */
const editing = ref<AgentApprovalView | null>(null);
const editRows = ref<{ key: string; value: string; json: boolean }[]>([]);
const editNote = ref('');
function openEdit(a: AgentApprovalView) {
  editing.value = a;
  editNote.value = '';
  editRows.value = params(a.input).map(([key, v]) => ({ key, value: typeof v === 'string' ? v : JSON.stringify(v, null, 2), json: typeof v !== 'string' }));
}
async function saveEdit() {
  if (!editing.value) return;
  const input: Record<string, unknown> = {};
  try {
    for (const r of editRows.value) input[r.key] = r.json ? JSON.parse(r.value) : r.value;
  } catch {
    return toast('One of the values isn’t valid JSON (check brackets and quotes)', 'error');
  }
  try {
    await api(`/approvals/${editing.value.approvalId}/edit`, { method: 'POST', body: { input, note: editNote.value || undefined } });
    toast('Changed. Check the new version below, then approve it.', 'success');
    editing.value = null;
    load();
  } catch (err) {
    toastError(err);
  }
}

/* ---------- policy (Admins) ---------- */
const policy = ref<{ lowRiskPolicy: LowRiskPolicy; approvalHours: number } | null>(null);
async function loadPolicy() {
  policy.value = await api<{ lowRiskPolicy: LowRiskPolicy; approvalHours: number }>('/approvals/policy', { quiet: true }).catch(() => null);
}
async function savePolicy() {
  if (!policy.value) return;
  try {
    await api('/approvals/policy', { method: 'PUT', body: policy.value });
    toast('Approval rules saved', 'success');
  } catch (err) {
    toastError(err);
  }
}
const levels = [1, 2, 3, 4] as RiskLevel[];
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1120px] mx-auto">
    <PageHeader title="Approvals" subtitle="What your AI staff want to do and are waiting for a person’s OK. Each approval covers exactly the action shown — once." />

    <div class="grid lg:grid-cols-[minmax(0,1fr)_300px] gap-5 items-start">
      <div class="min-w-0">
        <div class="flex gap-1 border-b border-line mb-4">
          <button v-for="t in ([['pending', 'Waiting'], ['history', 'History']] as const)" :key="t[0]" class="h-9 px-3 text-[13px] font-medium border-b-2 -mb-px transition-colors" :class="tab === t[0] ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-ink'" data-no-loading @click="tab = t[0]">
            {{ t[1] }}<span v-if="t[0] === 'pending' && tab === 'pending' && items.length" class="ml-1.5 chip h-5 text-[11px] border-0 bg-warn-soft text-warn">{{ items.length }}</span>
          </button>
        </div>

        <Skeleton v-if="loading" kind="list" :rows="4" />
        <div v-else-if="!items.length" class="card">
          <EmptyState :icon="ShieldCheck" :title="tab === 'pending' ? 'Nothing waiting' : 'No decisions yet'" :text="tab === 'pending' ? 'When an AI employee wants to send, run or change something, it waits here for your OK.' : 'Approved, rejected and expired requests appear here.'" />
        </div>

        <div v-else class="space-y-3">
          <article
            v-for="(a, i) in items"
            :key="a.approvalId"
            class="card p-4 animate-in"
            :class="[focus === a.approvalId ? 'ring-2 ring-brand' : '', a.level === 4 && a.status === 'pending' ? 'border-bad/40' : '']"
            :style="{ '--i': Math.min(i, 8) }"
          >
            <div class="flex items-start gap-3">
              <AgentAvatar :avatar="a.agentAvatar" :color="a.agentColor" :size="38" />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-semibold text-[14px]">{{ a.agentName }}</span>
                  <RiskBadge :level="a.level" />
                  <span v-if="a.status !== 'pending'" class="chip h-5 text-[11px] border-0" :class="STATUS[a.status]?.cls">{{ STATUS[a.status]?.label }}</span>
                  <span v-if="a.editedFrom" class="chip h-5 text-[11px]">edited by {{ a.editedBy === auth.profile?.uid ? 'you' : 'an approver' }}</span>
                </div>
                <p class="text-[12px] text-subtle">
                  For {{ a.requestedFor === auth.profile?.uid ? 'you' : a.requestedForName }} · {{ a.source === 'chat' ? 'in a chat' : 'background task' }} “{{ a.title }}” · {{ timeAgo(a.createdAt) }}
                </p>
              </div>
              <span v-if="a.status === 'pending'" class="text-[12px] shrink-0 inline-flex items-center gap-1" :class="Date.parse(a.expiresAt) - Date.now() < 3600_000 ? 'text-bad' : 'text-subtle'"><Clock class="size-3.5" />{{ left(a.expiresAt) }}</span>
            </div>

            <div class="mt-3 rounded-lg border border-line p-3">
              <div class="text-[13.5px] font-medium">{{ a.toolLabel }}</div>
              <p class="text-[13px] text-muted mt-0.5 whitespace-pre-wrap">{{ a.details }}</p>
              <p v-if="a.reason" class="text-[12.5px] mt-1.5"><span class="text-subtle">Why: </span>“{{ a.reason }}”</p>
              <dl class="mt-2.5 grid grid-cols-[110px_minmax(0,1fr)] gap-y-1 text-[12.5px]">
                <dt class="text-subtle">Where</dt><dd>{{ a.target }}</dd>
                <template v-for="[k, v] in params(a.input)" :key="k">
                  <dt class="text-subtle truncate">{{ k }}</dt><dd><code class="break-all text-[12px]">{{ show(v) }}</code></dd>
                </template>
              </dl>
            </div>

            <p v-if="a.status !== 'pending' && a.decidedAt" class="text-[12px] text-subtle mt-2">
              {{ a.status === 'expired' ? 'Expired' : `${STATUS[a.status]?.label} by ${a.decidedByName ?? 'someone'}` }} · {{ new Date(a.decidedAt).toLocaleString() }}<template v-if="a.note"> — “{{ a.note }}”</template><template v-if="a.usedAt"> · carried out {{ timeAgo(a.usedAt) }}</template>
            </p>

            <div v-if="a.status === 'pending'" class="flex flex-wrap items-center gap-2 mt-3">
              <template v-if="a.canDecide">
                <button class="btn-primary h-8" @click="ask(a, true)"><Check class="size-4" />Approve</button>
                <button class="btn-secondary h-8" @click="ask(a, false)"><X class="size-4" />Reject</button>
                <button class="btn-ghost h-8" @click="openEdit(a)"><Pencil class="size-4" />Edit</button>
              </template>
              <p v-else class="text-[12.5px] text-subtle">{{ a.whyNot }}.</p>
              <RouterLink v-if="a.source === 'task' && a.taskId" :to="{ path: '/ai-tasks', query: { task: a.taskId } }" class="text-[12.5px] text-brand hover:underline ml-auto">Open the task</RouterLink>
              <RouterLink v-else-if="a.chatId && a.requestedFor === auth.profile?.uid" :to="`/ai-staff/${a.agentId}/chat/${a.chatId}`" class="text-[12.5px] text-brand hover:underline ml-auto">Open the chat</RouterLink>
            </div>
          </article>
        </div>
      </div>

      <aside class="space-y-3 lg:sticky lg:top-6">
        <div class="card p-4 text-[12.5px] animate-in">
          <h2 class="section-title mb-2">Risk levels</h2>
          <ul class="space-y-2">
            <li v-for="l in levels" :key="l"><RiskBadge :level="l" /><p class="text-muted mt-0.5">{{ RISK_LEVELS[l].explain }}</p></li>
          </ul>
        </div>
        <div v-if="isAdmin && policy" class="card p-4 text-[12.5px] animate-in" style="--i: 1">
          <h2 class="section-title mb-2">Rules (Admins)</h2>
          <label class="label">Level 2 (low risk)</label>
          <select v-model="policy.lowRiskPolicy" class="input h-8 text-[12.5px]">
            <option v-for="(label, k) in LOW_RISK_POLICY_LABELS" :key="k" :value="k">{{ label }}</option>
          </select>
          <label class="label mt-3">Requests expire after</label>
          <select v-model.number="policy.approvalHours" class="input h-8 text-[12.5px]">
            <option :value="1">1 hour</option><option :value="4">4 hours</option><option :value="12">12 hours</option><option :value="24">1 day</option><option :value="72">3 days</option>
          </select>
          <p class="text-subtle mt-1">Critical (level 4) requests always expire within 2 hours.</p>
          <button class="btn-secondary h-8 w-full mt-3" @click="savePolicy">Save rules</button>
          <p class="text-subtle mt-2">Who may approve an AI employee’s actions: the person it works for (up to level 3), Admins, and the approvers named on its edit page.</p>
        </div>
      </aside>
    </div>

    <Modal v-if="deciding" :title="deciding.approve ? 'Approve this action?' : 'Reject this action?'" width="500px" @close="deciding = null">
      <p class="text-[13px]"><b>{{ deciding.a.agentName }}</b>: {{ deciding.a.toolLabel }}</p>
      <p class="text-[12.5px] text-muted mt-1">{{ deciding.approve ? 'It will do exactly this, once, with the parameters shown.' : 'It will be told not to do it and will carry on without it.' }}</p>
      <div v-if="deciding.approve && deciding.a.level === 4" class="mt-4 rounded-lg bg-bad-soft p-3">
        <p class="text-[12.5px] text-bad font-medium">Critical action. Type {{ CRITICAL_CONFIRM_WORD }} to confirm.</p>
        <input v-model="word" class="input mt-2" :placeholder="CRITICAL_CONFIRM_WORD" autocomplete="off" />
      </div>
      <label class="label mt-4">Note (optional)</label>
      <input v-model="note" class="input" maxlength="500" :placeholder="deciding.approve ? 'e.g. OK for this month only' : 'e.g. Not before the owner confirms'" />
      <template #footer>
        <button class="btn-secondary" @click="deciding = null">Cancel</button>
        <button :class="deciding.approve ? 'btn-primary' : 'btn-danger'" :disabled="busy || (deciding.approve && deciding.a.level === 4 && word.trim().toUpperCase() !== CRITICAL_CONFIRM_WORD)" @click="decide">
          {{ deciding.approve ? 'Approve' : 'Reject' }}
        </button>
      </template>
    </Modal>

    <Modal v-if="editing" title="Edit the action" width="560px" @close="editing = null">
      <p class="text-[12.5px] text-muted -mt-1 mb-3">Change what it will do. This makes a new request that someone allowed (you too) must approve. The old one is closed.</p>
      <div class="space-y-3">
        <div v-for="r in editRows" :key="r.key">
          <label class="label">{{ r.key }}<span v-if="r.json" class="text-subtle font-normal"> (JSON)</span></label>
          <textarea v-if="r.json || r.value.length > 60" v-model="r.value" class="textarea font-mono text-[12px]" rows="3" />
          <input v-else v-model="r.value" class="input" />
        </div>
        <div><label class="label">Why you changed it (optional)</label><input v-model="editNote" class="input" maxlength="500" /></div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="editing = null">Cancel</button>
        <button class="btn-primary" @click="saveEdit">Save as new request</button>
      </template>
    </Modal>
  </div>
</template>
