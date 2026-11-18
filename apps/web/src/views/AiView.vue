<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ArrowRight, Bot, CheckCircle2, GlobeLock, MessageSquare, ScanText, ShieldCheck, Sparkles, Tags } from '@lucide/vue';
import { AI_SERVICE_INFO, type AssistantSettings, type AssistantStatus, type WorkflowTemplate } from '@widebed/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';
import { useAuthStore } from '@/stores/auth';
import { useCredentialsStore } from '@/stores/credentials';

const auth = useAuthStore();
const store = useCredentialsStore();
const router = useRouter();
const aiTemplates = ref<WorkflowTemplate[]>([]);
const aiConnections = computed(() => store.byProvider('ai_provider'));
const canManage = computed(() => auth.can('credential.manage'));

const assistant = ref<AssistantStatus | null>(null);
const form = ref<AssistantSettings>({ enabled: false, aiCredentialId: null, pmsCredentialId: null, browserEnabled: false });
const firebaseConnections = computed(() => store.byProvider('firebase_service_account'));
const websites = computed(() => store.byProvider('website_login'));
const saving = ref(false);
async function loadAssistant() {
  assistant.value = await api<AssistantStatus>('/assistant/status');
  if (assistant.value.settings) form.value = { ...assistant.value.settings };
}
async function saveAssistant() {
  saving.value = true;
  try {
    await api('/assistant/settings', { method: 'PUT', body: form.value });
    toast('Assistant settings saved', 'success');
    await loadAssistant();
  } catch (err) {
    toastError(err);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    await store.load(true);
    await loadAssistant();
    const t = await api<{ builtIn: WorkflowTemplate[]; saved: WorkflowTemplate[] }>('/templates');
    aiTemplates.value = [...t.builtIn, ...t.saved].filter((x) => x.category === 'AI');
  } catch (err) {
    toastError(err);
  }
});

const steps = [
  { icon: MessageSquare, name: 'AI Write / Answer', what: 'Writes, summarises or translates text — e.g. a draft reply to a guest.', example: '“Write a short, friendly reply to this guest email: {{ $json.body }}”' },
  { icon: Tags, name: 'AI Sort into Categories', what: 'Reads each item and sends it down the right path — like a Switch, but AI decides.', example: 'Question · Complaint · Cancellation → a different team for each' },
  { icon: ScanText, name: 'AI Pull Out Details', what: 'Turns free text into tidy fields you can save or use.', example: 'Booking email → guest name, check-in, check-out, property' },
  { icon: Bot, name: 'AI Agent', what: 'Gives the Widebed Assistant a whole job to do on a schedule, using PMS data, workflows and saved websites.', example: '“Every 1st of the month: sign in to myTNB and list the unpaid bills”' },
];
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1100px] mx-auto">
    <PageHeader title="AI Settings" subtitle="Connect AI services, switch AI staff on, and use AI inside workflows.">
      <RouterLink to="/ai-staff" class="btn-primary"><Sparkles class="size-4" />Open AI Staff</RouterLink>
    </PageHeader>

    <!-- Assistant -->
    <section class="card p-5 mb-4">
      <div class="flex flex-wrap items-center gap-3">
        <span class="size-10 rounded-lg bg-[#efe8f5] text-[#6c4a8f] dark:bg-[#2a2233] dark:text-[#b99ad6] grid place-items-center shrink-0"><Sparkles class="size-5" /></span>
        <div class="flex-1 min-w-[220px]">
          <h2 class="section-title">AI Staff &amp; Widebed Assistant</h2>
          <p class="text-[13px] text-muted">Shared settings for all AI employees: the default AI service, the read-only PMS connection, and the web browser for saved websites. Each AI employee can pick its own AI service on the AI Staff page.</p>
        </div>
        <span v-if="assistant" class="chip" :class="assistant.ready ? 'text-ok' : 'text-warn'">{{ assistant.ready ? 'Ready' : 'Not ready' }}</span>
      </div>
      <p v-if="assistant && !assistant.ready" class="text-[12.5px] text-warn mt-3">{{ assistant.problem }}</p>

      <form v-if="assistant?.canManage" class="mt-4 grid md:grid-cols-2 gap-4" @submit.prevent="saveAssistant">
        <label class="flex items-center gap-2 text-[13px] md:col-span-2"><input v-model="form.enabled" type="checkbox" class="accent-[var(--wb-brand)]" />Switch AI staff on for everyone</label>
        <div>
          <label class="label">AI service it thinks with</label>
          <select v-model="form.aiCredentialId" class="input">
            <option :value="null">— choose —</option>
            <option v-for="c in aiConnections" :key="c.credentialId" :value="c.credentialId">{{ c.name }} ({{ c.details.model }})</option>
          </select>
          <p v-if="!aiConnections.length" class="text-[11px] text-subtle mt-1">Connect an AI service first (button above).</p>
        </div>
        <div>
          <label class="label">Widebed PMS data (read-only connection)</label>
          <select v-model="form.pmsCredentialId" class="input">
            <option :value="null">— none —</option>
            <option v-for="c in firebaseConnections" :key="c.credentialId" :value="c.credentialId" :disabled="!c.details.readOnly">{{ c.name }}{{ c.details.readOnly ? '' : ' (not read-only — not allowed)' }}</option>
          </select>
          <p class="text-[11px] text-subtle mt-1">Only Department Managers, Admins and IT can ask about PMS data. Employees cannot.</p>
        </div>
        <div class="md:col-span-2 rounded-md border border-line p-3">
          <label class="flex items-center gap-2 text-[13px]"><input v-model="form.browserEnabled" type="checkbox" class="accent-[var(--wb-brand)]" />Let the assistant use a web browser with saved website logins</label>
          <ul v-if="websites.length" class="mt-2 space-y-1">
            <li v-for="w in websites" :key="w.credentialId" class="flex items-center gap-2 text-[12.5px]"><GlobeLock class="size-3.5 text-subtle" />{{ w.name }} <span class="text-subtle">· {{ w.details.allowedDomains?.join(', ') }} · {{ w.details.usernameHint }}</span></li>
          </ul>
          <p v-else class="text-[12px] text-subtle mt-2">No website logins yet.</p>
          <RouterLink :to="{ path: '/credentials', query: { add: 'website' } }" class="text-[12.5px] text-brand mt-2 inline-block">+ Add a website login (e.g. myTNB)</RouterLink>
          <p class="text-[11px] text-subtle mt-1">Needs the browser installed on the server (README → Assistant browser).</p>
        </div>
        <div class="md:col-span-2 flex justify-end"><button class="btn-primary" :disabled="saving">Save</button></div>
      </form>
    </section>

    <!-- 1. Connection -->
    <section class="card p-5 mb-4">
      <div class="flex flex-wrap items-center gap-3">
        <span class="size-10 rounded-lg bg-[#efe8f5] text-[#6c4a8f] dark:bg-[#2a2233] dark:text-[#b99ad6] grid place-items-center shrink-0"><Bot class="size-5" /></span>
        <div class="flex-1 min-w-[200px]">
          <h2 class="section-title">1. Connect an AI service</h2>
          <p class="text-[13px] text-muted">OpenAI (ChatGPT), Anthropic (Claude) or Google Gemini. You pay the AI company per use.</p>
        </div>
        <button v-if="canManage" class="btn-primary" @click="router.push({ path: '/credentials', query: { add: 'openai' } })">{{ aiConnections.length ? 'Add another' : 'Connect AI' }}</button>
        <span v-else-if="!aiConnections.length" class="text-[12px] text-subtle">Ask an IT Admin to connect one.</span>
      </div>
      <ul v-if="aiConnections.length" class="mt-4 space-y-1.5">
        <li v-for="c in aiConnections" :key="c.credentialId" class="flex flex-wrap items-center gap-2 text-[13px] rounded-md bg-surface-2 px-3 py-2">
          <CheckCircle2 class="size-4 text-ok" />
          <span class="font-medium">{{ c.name }}</span>
          <span class="text-subtle">{{ c.details.aiService ? AI_SERVICE_INFO[c.details.aiService].label : '' }} · {{ c.details.model }}</span>
          <StatusBadge class="ml-auto" :status="c.status === 'connected' ? 'active' : c.status === 'error' ? 'failed' : 'pending'" />
        </li>
      </ul>
    </section>

    <!-- 2. AI steps -->
    <section class="card p-5 mb-4">
      <h2 class="section-title">2. Add an AI step to a workflow</h2>
      <p class="text-[13px] text-muted mb-4">In the editor, open the <b>AI</b> group on the left and drag one of these onto the canvas, then choose your AI connection.</p>
      <div class="grid md:grid-cols-2 xl:grid-cols-4 gap-3">
        <div v-for="s in steps" :key="s.name" class="rounded-lg border border-line p-3.5">
          <div class="flex items-center gap-2 font-medium text-[13px]"><component :is="s.icon" class="size-4 text-[#6c4a8f] dark:text-[#b99ad6]" />{{ s.name }}</div>
          <p class="text-[12.5px] text-muted mt-1.5 leading-relaxed">{{ s.what }}</p>
          <p class="text-[12px] text-subtle mt-2 font-mono break-words">{{ s.example }}</p>
        </div>
      </div>
    </section>

    <!-- 3. Templates -->
    <section class="card p-5 mb-4">
      <h2 class="section-title">3. Or start from an AI template</h2>
      <div v-if="aiTemplates.length" class="mt-3 divide-y divide-line">
        <RouterLink v-for="t in aiTemplates" :key="t.templateId" :to="{ path: '/templates', query: { category: 'AI' } }" class="flex items-center gap-3 py-2.5 group">
          <div class="flex-1 min-w-0">
            <div class="font-medium text-[13px] group-hover:text-brand">{{ t.name }}</div>
            <div class="text-[12px] text-muted truncate">{{ t.description }}</div>
          </div>
          <ArrowRight class="size-4 text-subtle group-hover:text-brand" />
        </RouterLink>
      </div>
      <p v-else class="text-[13px] text-muted mt-2">No AI templates yet.</p>
    </section>

    <!-- Good practice -->
    <div class="grid md:grid-cols-1 gap-4">
      <section class="card p-5">
        <h2 class="section-title flex items-center gap-2"><ShieldCheck class="size-4 text-brand" />Use AI safely</h2>
        <ul class="text-[13px] text-muted mt-2 space-y-1.5 list-disc pl-4">
          <li>AI can be wrong. Let it <b>draft</b> guest emails for your team to check, rather than sending them directly.</li>
          <li>Don’t let AI decide refunds or payments on its own.</li>
          <li>Set a monthly spending limit in your AI account. Each item in a workflow is one paid request.</li>
          <li>Text you send goes to the AI company — avoid passport numbers and card details.</li>
        </ul>
      </section>

    </div>
  </div>
</template>
