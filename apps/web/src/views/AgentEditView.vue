<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft, BookOpen, Brain, Briefcase, Check, Cpu, Lock, MessageSquare, RefreshCw, Save, ShieldCheck, Sparkles, UserCheck, Users, Wrench, X } from '@lucide/vue';
import { AGENT_COLORS, blankAgent, type AgentInput, type AgentSummary, type AiAgent, type Credential, type PersonSummary } from '@widebed/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import AgentAvatar from '@/components/ai/AgentAvatar.vue';
import AgentMemoryReview from '@/components/ai/AgentMemoryReview.vue';
import { api } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';
import { roleLabels } from '@/lib/format';

/**
 * Create or edit one AI employee. Sections follow how you'd brief a new hire:
 * who they are → their job → how they behave → which AI brain → tools → who may use them.
 */
const route = useRoute();
const router = useRouter();
const agentId = computed(() => (typeof route.params.id === 'string' ? route.params.id : null));
const isNew = computed(() => !agentId.value);

const form = ref<AgentInput>(blankAgent());
const original = ref<AiAgent | null>(null);
const loading = ref(true);
const saving = ref(false);
const aiConns = ref<Credential[]>([]);
const websites = ref<Credential[]>([]);
const people = ref<PersonSummary[]>([]);
const models = ref<{ id: string; label: string }[]>([]);
const modelsError = ref<string | null>(null);
const loadingModels = ref(false);
const customModel = ref(false);
/** Admins change everything; a delegated manager only the job and behaviour (the server enforces the same). */
const fullControl = ref(true);
const access = ref<{ uid: string; name: string; email: string; department: string | null; why: string }[] | null>(null);
const showAccess = ref(false);

const EMOJIS = ['🤖', '✨', '🧭', '🏨', '💰', '🧑‍💼', '🛠️', '📣', '⚙️', '🧹', '🔑', '📊', '📅', '🧾', '🏠', '📞', '🛎️', '🔍', '🧠', '🌟'];

onMounted(async () => {
  try {
    const [creds, ppl] = await Promise.all([
      api<{ items: Credential[] }>('/credentials').catch(() => ({ items: [] as Credential[] })),
      api<{ items: PersonSummary[] }>('/people').catch(() => ({ items: [] as PersonSummary[] })),
    ]);
    aiConns.value = creds.items.filter((c) => c.provider === 'ai_provider');
    websites.value = creds.items.filter((c) => c.provider === 'website_login');
    people.value = ppl.items;
    if (agentId.value) {
      const res = await api<{ agent?: AiAgent; summary: AgentSummary }>(`/agents/${agentId.value}`);
      if (!res.agent) throw new Error('Only Admins and this AI employee’s managers can change it');
      original.value = res.agent;
      fullControl.value = res.summary.canManage;
      const { agentId: _a, builtIn: _b, createdBy: _c, createdAt: _d, updatedAt: _e, lastActiveAt: _f, ...input } = res.agent;
      form.value = { ...blankAgent(), ...input };
      loadAccess();
    }
    if (fullControl.value) loadModels();
  } catch (err) {
    toastError(err);
  } finally {
    loading.value = false;
  }
});

/** The connection whose models we list: the agent's own, or the default one from AI Settings. */
const effectiveConn = computed(() => form.value.aiCredentialId ?? aiConns.value[0]?.credentialId ?? null);
async function loadModels() {
  const id = effectiveConn.value;
  models.value = [];
  modelsError.value = null;
  if (!id) return;
  loadingModels.value = true;
  try {
    models.value = (await api<{ models: { id: string; label: string }[] }>('/agents/models', { query: { credentialId: id }, quiet: true })).models;
    if (form.value.model && !models.value.some((m) => m.id === form.value.model)) customModel.value = true;
  } catch (err) {
    modelsError.value = (err as Error).message;
  } finally {
    loadingModels.value = false;
  }
}
watch(() => form.value.aiCredentialId, () => {
  form.value.model = null;
  customModel.value = false;
  loadModels();
});

async function loadAccess() {
  if (!agentId.value) return;
  try {
    access.value = (await api<{ items: typeof access.value }>(`/agents/${agentId.value}/access`, { quiet: true })).items;
  } catch {
    access.value = null;
  }
}

/* list fields typed as chips */
const newResp = ref('');
const newSkill = ref('');
function addResp() {
  const t = newResp.value.trim();
  if (t && !form.value.responsibilities.includes(t)) form.value.responsibilities.push(t);
  newResp.value = '';
}
function addSkill() {
  const t = newSkill.value.trim();
  if (t && !form.value.expertise.includes(t)) form.value.expertise.push(t);
  newSkill.value = '';
}

const departments = computed(() => [...new Set(people.value.map((p) => p.department).filter(Boolean))] as string[]);
const personQ = ref('');
const personMatches = computed(() => {
  const s = personQ.value.trim().toLowerCase();
  if (!s) return [];
  return people.value.filter((p) => !form.value.allowedUserIds.includes(p.uid) && `${p.name} ${p.email}`.toLowerCase().includes(s)).slice(0, 6);
});
const personName = (uid: string) => people.value.find((p) => p.uid === uid)?.name ?? 'Unknown person';
const approverQ = ref('');
const approverMatches = computed(() => {
  const s = approverQ.value.trim().toLowerCase();
  if (!s) return [];
  return people.value.filter((p) => !form.value.approverIds.includes(p.uid) && `${p.name} ${p.email}`.toLowerCase().includes(s)).slice(0, 6);
});
const managerQ = ref('');
const managerMatches = computed(() => {
  const s = managerQ.value.trim().toLowerCase();
  if (!s) return [];
  return people.value.filter((p) => !form.value.managerIds.includes(p.uid) && `${p.name} ${p.email}`.toLowerCase().includes(s)).slice(0, 6);
});

const useTemp = computed({
  get: () => form.value.temperature !== null,
  set: (v: boolean) => (form.value.temperature = v ? 0.3 : null),
});
/** Company Knowledge is on unless switched off (older AI staff have no setting yet). */
const useKnowledge = computed({
  get: () => form.value.tools.knowledge !== false,
  set: (v: boolean) => (form.value.tools.knowledge = v),
});
const allSites = computed({
  get: () => form.value.tools.websites === 'all',
  set: (v: boolean) => (form.value.tools.websites = v ? 'all' : []),
});
function toggleSite(id: string) {
  const list = form.value.tools.websites === 'all' ? [] : [...form.value.tools.websites];
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  else list.push(id);
  form.value.tools.websites = list;
}
function toggleRole(r: string) {
  const i = form.value.allowedRoles.indexOf(r);
  if (i >= 0) form.value.allowedRoles.splice(i, 1);
  else form.value.allowedRoles.push(r);
}

async function save() {
  addResp();
  addSkill();
  if (!form.value.name.trim()) return toast('Give the AI employee a name', 'error');
  saving.value = true;
  try {
    const body = { ...form.value, department: form.value.department?.trim() || null, model: form.value.model?.trim() || null };
    const saved = isNew.value
      ? await api<AiAgent>('/agents', { method: 'POST', body })
      : await api<AiAgent>(`/agents/${agentId.value}`, { method: 'PUT', body });
    toast(isNew.value ? `${saved.name} has joined the team` : 'Saved', 'success');
    if (isNew.value || route.query.new) router.push(`/ai-staff/${saved.agentId}/chat`);
    else {
      original.value = saved;
      loadAccess();
    }
  } catch (err) {
    toastError(err);
  } finally {
    saving.value = false;
  }
}
const ROLES = ['admin', 'it_admin', 'department_manager', 'employee'] as const;
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1120px] mx-auto">
    <RouterLink to="/ai-staff" class="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink mb-3"><ArrowLeft class="size-4" />AI Staff</RouterLink>
    <PageHeader :title="isNew ? 'New AI employee' : `Edit ${original?.name ?? ''}`" :subtitle="route.query.new ? 'Created from a template — check the details, then save.' : 'Brief your AI employee like a new hire: its job, how it behaves and what it may use.'">
      <RouterLink v-if="!isNew" :to="`/ai-staff/${agentId}/chat`" class="btn-secondary"><MessageSquare class="size-4" />Chat</RouterLink>
      <button class="btn-primary" :disabled="saving || loading" @click="save"><Save class="size-4" />{{ isNew ? 'Create' : 'Save' }}</button>
    </PageHeader>

    <div v-if="loading" class="grid lg:grid-cols-[minmax(0,1fr)_300px] gap-5"><div class="skeleton h-[480px] rounded-xl" /><div class="skeleton h-[260px] rounded-xl" /></div>

    <form v-else class="grid lg:grid-cols-[minmax(0,1fr)_300px] gap-5 items-start" @submit.prevent="save">
      <div class="space-y-5 min-w-0">
        <div v-if="!fullControl" class="card p-3 flex gap-2.5 items-start text-[13px] animate-in">
          <UserCheck class="size-4 text-brand shrink-0 mt-0.5" />
          <p>You look after this AI employee, so you can change its <b>job, behaviour and instructions</b>. Its name, AI brain, tools and who may use it are set by an Admin.</p>
        </div>
        <!-- Who -->
        <section class="card p-5 animate-in">
          <h2 class="section-title flex items-center gap-2 mb-4"><Sparkles class="size-4 text-muted" />Who they are</h2>
          <div class="grid sm:grid-cols-2 gap-4">
            <div><label class="label">Name</label><input v-model="form.name" class="input" maxlength="80" placeholder="e.g. Finance Assistant" required :disabled="!fullControl" /></div>
            <div><label class="label">Job title</label><input v-model="form.title" class="input" maxlength="80" placeholder="e.g. Finance & Utilities" /></div>
            <div>
              <label class="label">Department</label>
              <input v-model="form.department" class="input" list="wb-departments" maxlength="60" placeholder="e.g. Finance (optional)" :disabled="!fullControl" />
              <datalist id="wb-departments"><option v-for="d in departments" :key="d" :value="d" /></datalist>
            </div>
            <div>
              <label class="label">Colour</label>
              <div class="flex gap-1.5 h-9 items-center">
                <button
                  v-for="(c, key) in AGENT_COLORS"
                  :key="key"
                  type="button"
                  class="rounded-full transition-transform"
                  :class="form.color === key ? 'scale-110 ring-2 ring-brand ring-offset-2 ring-offset-surface' : 'hover:scale-105'"
                  :aria-label="c.label"
                  @click="form.color = key"
                >
                  <AgentAvatar :avatar="''" :color="key" :size="26" />
                </button>
              </div>
            </div>
            <div class="sm:col-span-2">
              <label class="label">Picture</label>
              <div class="flex flex-wrap gap-1">
                <button
                  v-for="e in EMOJIS"
                  :key="e"
                  type="button"
                  class="size-9 rounded-md text-[18px] grid place-items-center transition-colors"
                  :class="form.avatar === e ? 'bg-brand-soft ring-1 ring-brand' : 'hover:bg-surface-2'"
                  @click="form.avatar = e"
                >
                  {{ e }}
                </button>
                <input v-model="form.avatar" class="input w-[64px] text-center" maxlength="8" aria-label="Or type any emoji" />
              </div>
            </div>
            <div class="sm:col-span-2"><label class="label">What they do (shown on their card)</label><textarea v-model="form.description" class="textarea" rows="2" maxlength="500" placeholder="e.g. Checks outstanding utility bills and prepares finance summaries." /></div>
          </div>
        </section>

        <!-- Job -->
        <section class="card p-5 animate-in" style="--i: 1">
          <h2 class="section-title flex items-center gap-2 mb-4"><Briefcase class="size-4 text-muted" />Their job</h2>
          <label class="label">Responsibilities</label>
          <ul class="space-y-1.5 mb-2">
            <li v-for="(r, i) in form.responsibilities" :key="r" class="flex items-center gap-2 rounded-md bg-surface-2 px-3 py-1.5 text-[13px] animate-in">
              <span class="flex-1">{{ r }}</span>
              <button type="button" class="btn-ghost btn-icon size-6" :aria-label="`Remove ${r}`" @click="form.responsibilities.splice(i, 1)"><X class="size-3.5" /></button>
            </li>
          </ul>
          <input v-model="newResp" class="input" maxlength="200" placeholder="Type a responsibility and press Enter, e.g. “Check outstanding utility bills”" @keydown.enter.prevent="addResp" @blur="addResp" />
          <label class="label mt-4">Expertise</label>
          <div class="flex flex-wrap items-center gap-1.5 input h-auto min-h-9 py-1.5">
            <span v-for="(e, i) in form.expertise" :key="e" class="chip inline-flex items-center gap-1">{{ e }}<button type="button" class="hover:text-bad" :aria-label="`Remove ${e}`" @click="form.expertise.splice(i, 1)"><X class="size-3" /></button></span>
            <input v-model="newSkill" class="flex-1 min-w-[140px] bg-transparent outline-none text-[13px]" maxlength="60" placeholder="e.g. Utility bills — Enter to add" @keydown.enter.prevent="addSkill" @blur="addSkill" />
          </div>
        </section>

        <!-- Behaviour -->
        <section class="card p-5 animate-in" style="--i: 2">
          <h2 class="section-title flex items-center gap-2 mb-4"><MessageSquare class="size-4 text-muted" />How they behave</h2>
          <div class="grid sm:grid-cols-2 gap-4">
            <div><label class="label">Personality</label><textarea v-model="form.personality" class="textarea" rows="3" maxlength="500" /></div>
            <div><label class="label">How they write</label><textarea v-model="form.communicationStyle" class="textarea" rows="3" maxlength="500" /></div>
          </div>
          <label class="label mt-4">Instructions <span class="text-subtle font-normal">— only Admins can see these</span></label>
          <textarea
            v-model="form.instructions"
            class="textarea font-mono text-[12.5px]"
            rows="7"
            maxlength="8000"
            placeholder="Anything they must always do or never do. e.g.&#10;- Always show amounts as RM with 2 decimals.&#10;- Sort bills by due date, overdue first.&#10;- If a bill is over RM 500, say so at the top."
          />
          <p class="text-[12px] text-subtle mt-1">The built-in safety rules (never pay, never reveal passwords, PMS is read-only…) always apply on top of these.</p>
        </section>

        <fieldset :disabled="!fullControl" class="space-y-5 min-w-0" :class="{ 'opacity-60': !fullControl }">
        <!-- Brain -->
        <section class="card p-5 animate-in" style="--i: 3">
          <h2 class="section-title flex items-center gap-2 mb-4"><Cpu class="size-4 text-muted" />AI brain</h2>
          <div class="grid sm:grid-cols-2 gap-4">
            <div>
              <label class="label">AI service</label>
              <select v-model="form.aiCredentialId" class="input">
                <option :value="null">Same as AI Settings (default)</option>
                <option v-for="c in aiConns" :key="c.credentialId" :value="c.credentialId">{{ c.name }}</option>
              </select>
              <p v-if="!aiConns.length" class="text-[12px] text-warn mt-1">No AI connection yet — add one on the <RouterLink to="/credentials" class="underline">Credentials</RouterLink> page.</p>
            </div>
            <div>
              <label class="label flex items-center justify-between">
                <span>Model</span>
                <button type="button" class="text-[11.5px] text-brand inline-flex items-center gap-1" data-no-loading :disabled="loadingModels" @click="loadModels"><RefreshCw class="size-3" :class="{ 'animate-spin': loadingModels }" />Refresh list</button>
              </label>
              <select v-if="!customModel" v-model="form.model" class="input" :disabled="loadingModels">
                <option :value="null">The connection’s model (default)</option>
                <option v-for="m in models" :key="m.id" :value="m.id">{{ m.label }}{{ m.label !== m.id ? ` (${m.id})` : '' }}</option>
              </select>
              <input v-else v-model="form.model" class="input" placeholder="Exact model name" />
              <p class="text-[12px] mt-1" :class="modelsError ? 'text-warn' : 'text-subtle'">
                <template v-if="modelsError">Couldn’t load the list: {{ modelsError }}</template>
                <template v-else-if="models.length">{{ models.length }} models available from this AI service.</template>
                <button type="button" class="text-brand ml-1" @click="customModel = !customModel">{{ customModel ? 'Pick from the list' : 'Type a name instead' }}</button>
              </p>
            </div>
            <div>
              <label class="label flex items-center gap-2"><input v-model="useTemp" type="checkbox" class="size-4 accent-[var(--color-brand)]" />Set creativity (temperature)</label>
              <div v-if="form.temperature !== null" class="flex items-center gap-3">
                <span class="text-[11.5px] text-subtle">Exact</span>
                <input v-model.number="form.temperature" type="range" min="0" max="1" step="0.1" class="flex-1 accent-[var(--color-brand)]" />
                <span class="text-[11.5px] text-subtle">Creative</span>
                <span class="text-[12px] tabular-nums w-6">{{ form.temperature.toFixed(1) }}</span>
              </div>
              <p v-else class="text-[12px] text-subtle">Off: the AI service decides. Leave off unless you need it — some newer models refuse it.</p>
            </div>
            <div>
              <label class="label">Longest answer</label>
              <select v-model.number="form.maxOutputTokens" class="input">
                <option :value="2000">Short (2 000 tokens)</option>
                <option :value="4000">Medium (4 000)</option>
                <option :value="8000">Long (8 000) — recommended</option>
                <option :value="16000">Very long (16 000)</option>
              </select>
            </div>
            <div>
              <label class="label">Most steps per message</label>
              <input v-model.number="form.maxSteps" type="number" min="1" max="30" class="input w-[120px]" />
              <p class="text-[12px] text-subtle mt-1">After this many tool steps it stops and asks you how to continue.</p>
            </div>
          </div>
        </section>

        <!-- Tools -->
        <section class="card p-5 animate-in" style="--i: 4">
          <h2 class="section-title flex items-center gap-2 mb-1"><Wrench class="size-4 text-muted" />What they may use</h2>
          <p class="text-[12.5px] text-muted mb-4">Give only what the job needs. The person chatting must also be allowed to use it (e.g. PMS data is for managers and admins).</p>
          <div class="grid sm:grid-cols-2 gap-2.5">
            <label class="flex gap-3 items-start rounded-lg border border-line p-3 cursor-pointer hover:border-line-strong" :class="{ 'border-brand bg-brand-soft/40': form.tools.memory && form.memoryEnabled }">
              <input v-model="form.memoryEnabled" type="checkbox" class="size-4 mt-0.5 accent-[var(--color-brand)]" @change="form.tools.memory = form.memoryEnabled" />
              <span><span class="flex items-center gap-1.5 font-medium text-[13px]"><Brain class="size-3.5" />Memory</span><span class="block text-[12px] text-muted">Remembers facts each person tells it (its own memory, separate from other AI staff).</span></span>
            </label>
            <label class="flex gap-3 items-start rounded-lg border border-line p-3 cursor-pointer hover:border-line-strong" :class="{ 'border-brand bg-brand-soft/40': useKnowledge }">
              <input v-model="useKnowledge" type="checkbox" class="size-4 mt-0.5 accent-[var(--color-brand)]" />
              <span><span class="flex items-center gap-1.5 font-medium text-[13px]"><BookOpen class="size-3.5" />Company Knowledge</span><span class="block text-[12px] text-muted">Looks up your SOPs, house rules and policies before answering (only documents the person may read).</span></span>
            </label>
            <label class="flex gap-3 items-start rounded-lg border border-line p-3 cursor-pointer hover:border-line-strong" :class="{ 'border-brand bg-brand-soft/40': form.tools.pms }">
              <input v-model="form.tools.pms" type="checkbox" class="size-4 mt-0.5 accent-[var(--color-brand)]" />
              <span><span class="block font-medium text-[13px]">PMS data (read-only)</span><span class="block text-[12px] text-muted">Bookings, issues, properties… through the read-only connection in AI Settings.</span></span>
            </label>
            <label class="flex gap-3 items-start rounded-lg border border-line p-3 cursor-pointer hover:border-line-strong" :class="{ 'border-brand bg-brand-soft/40': form.tools.workflows }">
              <input v-model="form.tools.workflows" type="checkbox" class="size-4 mt-0.5 accent-[var(--color-brand)]" />
              <span><span class="block font-medium text-[13px]">Run workflows</span><span class="block text-[12px] text-muted">Published workflows the person may run. Always asks before running.</span></span>
            </label>
            <label class="flex gap-3 items-start rounded-lg border border-line p-3 cursor-pointer hover:border-line-strong" :class="{ 'border-brand bg-brand-soft/40': form.tools.browser }">
              <input v-model="form.tools.browser" type="checkbox" class="size-4 mt-0.5 accent-[var(--color-brand)]" />
              <span><span class="block font-medium text-[13px]">Saved websites</span><span class="block text-[12px] text-muted">Logs in with saved logins (it never sees the passwords). Asks before risky clicks.</span></span>
            </label>
          </div>
          <label class="mt-2.5 flex gap-3 items-start rounded-lg border border-line p-3 cursor-pointer hover:border-line-strong" :class="{ 'border-brand bg-brand-soft/40': form.canDelegate }">
            <input v-model="form.canDelegate" type="checkbox" class="size-4 mt-0.5 accent-[var(--color-brand)]" />
            <span>
              <span class="block font-medium text-[13px]">Manager: hand work to other AI staff</span>
              <span class="block text-[12px] text-muted">Splits big requests between colleagues (at the same time or one after another) and combines their results. Colleagues then only get the tools ticked above — never more — and can’t hand work on.</span>
            </span>
          </label>
          <div v-if="form.tools.browser" class="mt-3 rounded-lg bg-surface-2 p-3 animate-in">
            <label class="flex items-center gap-2 text-[13px]"><input v-model="allSites" type="checkbox" class="size-4 accent-[var(--color-brand)]" />All saved websites</label>
            <div v-if="!allSites" class="flex flex-wrap gap-1.5 mt-2">
              <button
                v-for="w in websites"
                :key="w.credentialId"
                type="button"
                class="chip h-7 px-2.5"
                :class="Array.isArray(form.tools.websites) && form.tools.websites.includes(w.credentialId) ? 'bg-brand-soft text-brand border-brand' : ''"
                @click="toggleSite(w.credentialId)"
              >
                {{ w.name }}
              </button>
              <span v-if="!websites.length" class="text-[12px] text-subtle">No website logins saved yet (Credentials → Website login).</span>
            </div>
          </div>
        </section>

        <!-- Access -->
        <section class="card p-5 animate-in" style="--i: 5">
          <h2 class="section-title flex items-center gap-2 mb-4"><Lock class="size-4 text-muted" />Who may chat with them</h2>
          <div class="grid sm:grid-cols-3 gap-2.5">
            <label v-for="v in (['company', 'department', 'private'] as const)" :key="v" class="rounded-lg border p-3 cursor-pointer" :class="form.visibility === v ? 'border-brand bg-brand-soft/40' : 'border-line hover:border-line-strong'">
              <input v-model="form.visibility" type="radio" :value="v" class="sr-only" />
              <span class="block font-medium text-[13px]">{{ v === 'company' ? 'Everyone' : v === 'department' ? 'Their department' : 'Only me' }}</span>
              <span class="block text-[12px] text-muted mt-0.5">{{ v === 'company' ? 'All staff can chat with it.' : v === 'department' ? `Only staff in ${form.department || 'its department'}.` : 'Only you (and other admins).' }}</span>
            </label>
          </div>
          <p v-if="form.visibility === 'department' && !form.department" class="text-[12px] text-warn mt-2">Set a department above, or nobody but admins will see it.</p>

          <label class="label mt-4">Only these roles <span class="text-subtle font-normal">(none ticked = any role)</span></label>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="r in ROLES" :key="r" type="button" class="chip h-7 px-2.5" :class="form.allowedRoles.includes(r) ? 'bg-brand-soft text-brand border-brand' : ''" @click="toggleRole(r)">{{ roleLabels[r] }}</button>
          </div>

          <label class="label mt-4">Also these people <span class="text-subtle font-normal">(always allowed)</span></label>
          <div class="flex flex-wrap gap-1.5 mb-2">
            <span v-for="(uid, i) in form.allowedUserIds" :key="uid" class="chip inline-flex items-center gap-1 animate-in">{{ personName(uid) }}<button type="button" class="hover:text-bad" @click="form.allowedUserIds.splice(i, 1)"><X class="size-3" /></button></span>
          </div>
          <div class="relative max-w-[360px]">
            <input v-model="personQ" class="input" placeholder="Type a name to add someone…" />
            <ul v-if="personMatches.length" class="absolute z-10 mt-1 w-full card shadow-[var(--shadow-pop)] py-1">
              <li v-for="p in personMatches" :key="p.uid">
                <button type="button" class="w-full text-left px-3 py-1.5 text-[13px] hover:bg-surface-2" @click="(form.allowedUserIds.push(p.uid), (personQ = ''))">{{ p.name }} <span class="text-subtle">· {{ p.email }}</span></button>
              </li>
            </ul>
          </div>

          <label class="label mt-5 flex items-center gap-1.5"><ShieldCheck class="size-3.5" />Managers of this AI employee <span class="text-subtle font-normal">(e.g. the department head)</span></label>
          <p class="text-[12px] text-muted -mt-0.5 mb-2">They may change its job, behaviour and instructions — not its AI, tools or who may use it.</p>
          <div class="flex flex-wrap gap-1.5 mb-2">
            <span v-for="(uid, i) in form.managerIds" :key="uid" class="chip inline-flex items-center gap-1 animate-in"><ShieldCheck class="size-3 text-brand" />{{ personName(uid) }}<button type="button" class="hover:text-bad" @click="form.managerIds.splice(i, 1)"><X class="size-3" /></button></span>
          </div>
          <div class="relative max-w-[360px]">
            <input v-model="managerQ" class="input" placeholder="Type a name to add a manager…" />
            <ul v-if="managerMatches.length" class="absolute z-10 mt-1 w-full card shadow-[var(--shadow-pop)] py-1">
              <li v-for="p in managerMatches" :key="p.uid">
                <button type="button" class="w-full text-left px-3 py-1.5 text-[13px] hover:bg-surface-2" @click="(form.managerIds.push(p.uid), (managerQ = ''))">{{ p.name }} <span class="text-subtle">· {{ p.email }}</span></button>
              </li>
            </ul>
          </div>

          <label class="label mt-5 flex items-center gap-1.5"><Check class="size-3.5" />Approvers <span class="text-subtle font-normal">(may approve its actions, also critical ones)</span></label>
          <p class="text-[12px] text-muted -mt-0.5 mb-2">Admins can always approve. The person it works for can approve up to level 3 (sensitive).</p>
          <div class="flex flex-wrap gap-1.5 mb-2">
            <span v-for="(uid, i) in form.approverIds" :key="uid" class="chip inline-flex items-center gap-1 animate-in"><Check class="size-3 text-brand" />{{ personName(uid) }}<button type="button" class="hover:text-bad" @click="form.approverIds.splice(i, 1)"><X class="size-3" /></button></span>
          </div>
          <div class="relative max-w-[360px]">
            <input v-model="approverQ" class="input" placeholder="Type a name to add an approver…" />
            <ul v-if="approverMatches.length" class="absolute z-10 mt-1 w-full card shadow-[var(--shadow-pop)] py-1">
              <li v-for="p in approverMatches" :key="p.uid">
                <button type="button" class="w-full text-left px-3 py-1.5 text-[13px] hover:bg-surface-2" @click="(form.approverIds.push(p.uid), (approverQ = ''))">{{ p.name }} <span class="text-subtle">· {{ p.email }}</span></button>
              </li>
            </ul>
          </div>
        </section>
        </fieldset>

        <!-- Who can chat right now (after saving) -->
        <section v-if="access" class="card p-5 animate-in">
          <button type="button" class="w-full flex items-center justify-between" data-no-loading @click="showAccess = !showAccess">
            <span class="section-title flex items-center gap-2"><Users class="size-4 text-muted" />Who can chat with it now</span>
            <span class="text-[13px] text-muted">{{ access.length }} {{ access.length === 1 ? 'person' : 'people' }} · {{ showAccess ? 'Hide' : 'Show' }}</span>
          </button>
          <ul v-if="showAccess" class="mt-3 divide-y divide-line text-[13px]">
            <li v-for="p in access" :key="p.uid" class="py-1.5 flex items-center gap-2 animate-in">
              <span class="flex-1 min-w-0 truncate">{{ p.name }} <span class="text-subtle">· {{ p.email }}</span></span>
              <span class="chip text-[11px]">{{ p.why }}</span>
            </li>
          </ul>
          <p class="text-[12px] text-subtle mt-2">Based on the saved settings. Save first to see the effect of changes.</p>
        </section>

        <AgentMemoryReview v-if="!isNew && fullControl && agentId" :agent-id="agentId" :agent-name="original?.name ?? 'It'" />
      </div>

      <!-- Live preview -->
      <aside class="lg:sticky lg:top-6 space-y-3">
        <div class="card p-4 animate-in">
          <div class="text-[11.5px] text-subtle mb-3">Preview of their card</div>
          <div class="flex items-start gap-3">
            <AgentAvatar :avatar="form.avatar" :color="form.color" :size="46" />
            <div class="min-w-0">
              <div class="font-semibold text-[14.5px] truncate">{{ form.name || 'Name' }}</div>
              <div class="text-[12.5px] text-muted truncate">{{ form.title || 'Job title' }}<template v-if="form.department"> · {{ form.department }}</template></div>
            </div>
          </div>
          <p class="text-[13px] text-muted mt-3">{{ form.description || 'What they do…' }}</p>
          <ul v-if="form.responsibilities.length" class="mt-3 space-y-1 text-[12.5px]">
            <li v-for="r in form.responsibilities.slice(0, 5)" :key="r" class="flex gap-1.5"><span class="text-brand">•</span>{{ r }}</li>
          </ul>
        </div>
        <div v-if="fullControl" class="card p-4 text-[12.5px] text-muted animate-in" style="--i: 1">
          <label class="flex items-center justify-between">
            <span class="font-medium text-ink">Switched on</span>
            <input :checked="form.status === 'active'" type="checkbox" class="size-4 accent-[var(--color-brand)]" @change="form.status = ($event.target as HTMLInputElement).checked ? 'active' : 'disabled'" />
          </label>
          <p class="mt-1">When off, nobody can chat with it. Its settings and chats are kept.</p>
        </div>
        <button class="btn-primary w-full" type="submit" :disabled="saving"><Save class="size-4" />{{ isNew ? 'Create AI employee' : 'Save changes' }}</button>
      </aside>
    </form>
  </div>
</template>
