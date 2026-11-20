<script setup lang="ts">
import Skeleton from '@/components/ui/Skeleton.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Bot, Copy, Database, ExternalLink, GlobeLock, KeyRound, KeySquare, Mail, Plug, Radio, RefreshCw, Trash2, Upload } from '@lucide/vue';
import type { AiService, Credential } from '@widebed/shared';
import { AI_SERVICE_INFO, AI_SERVICES, PROVIDER_LABELS } from '@widebed/shared';
import { api } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';
import { timeAgo } from '@/lib/format';
import { useAuthStore } from '@/stores/auth';
import { useCredentialsStore } from '@/stores/credentials';
import Modal from '@/components/ui/Modal.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';

const auth = useAuthStore();
const store = useCredentialsStore();
const route = useRoute();
const router = useRouter();
const canManage = computed(() => auth.can('credential.manage'));
const busy = ref<string | null>(null);

const icons = { firebase_service_account: Database, google_oauth: Mail, event_source: Radio, ai_provider: Bot, website_login: GlobeLock, api_key: KeySquare } as const;

/* ---------- API key / token (HTTP Request "Sign in with") ---------- */
const showKey = ref(false);
const keyEditing = ref<Credential | null>(null);
const keyForm = ref({ name: '', department: '', headerName: 'Authorization', bearer: true, value: '', sites: '' });
function openKey(c?: Credential) {
  keyEditing.value = c ?? null;
  keyForm.value = c
    ? { name: c.name, department: c.department ?? '', headerName: c.details.headerName ?? 'Authorization', bearer: false, value: '', sites: (c.details.allowedDomains ?? []).join(', ') }
    : { name: '', department: '', headerName: 'Authorization', bearer: true, value: '', sites: '' };
  showKey.value = true;
}
/** "Bearer " is added for Authorization headers unless the key already has a word in front (e.g. "Bearer …", "Basic …"). */
const keyValue = () => {
  const v = keyForm.value.value.trim();
  if (!v) return '';
  return keyForm.value.bearer && /^authorization$/i.test(keyForm.value.headerName.trim()) && !/^\w+\s+\S/.test(v) ? `Bearer ${v}` : v;
};
async function saveKey() {
  busy.value = 'key';
  const f = keyForm.value;
  const body = { headerName: f.headerName.trim() || 'Authorization', allowedDomains: f.sites.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean), ...(keyValue() ? { value: keyValue() } : {}) };
  try {
    if (keyEditing.value) await api(`/credentials/${keyEditing.value.credentialId}`, { method: 'PATCH', body });
    else await api('/credentials/api-key', { method: 'POST', body: { ...body, name: f.name, department: f.department.trim() || null } });
    toast(keyEditing.value ? 'API key updated' : 'API key saved', 'success');
    showKey.value = false;
    store.load(true);
  } catch (err) {
    toastError(err);
  } finally {
    busy.value = null;
  }
}

/* ---------- Website login (assistant browser) ---------- */
const showSite = ref(false);
const siteEditing = ref<Credential | null>(null);
const site = ref({ name: '', department: '', loginUrl: '', otherSites: '', username: '', password: '', selUser: '', selPass: '', selSubmit: '' });
function openSite(c?: Credential) {
  siteEditing.value = c ?? null;
  site.value = c
    ? { name: c.name, department: c.department ?? '', loginUrl: c.details.loginUrl ?? '', otherSites: (c.details.allowedDomains ?? []).slice(1).join(', '), username: '', password: '', selUser: c.details.selectors?.username ?? '', selPass: c.details.selectors?.password ?? '', selSubmit: c.details.selectors?.submit ?? '' }
    : { name: '', department: '', loginUrl: '', otherSites: '', username: '', password: '', selUser: '', selPass: '', selSubmit: '' };
  showSite.value = true;
}
async function saveSite() {
  busy.value = 'site';
  const f = site.value;
  const body = {
    loginUrl: f.loginUrl,
    allowedDomains: f.otherSites.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean),
    selectors: { username: f.selUser, password: f.selPass, submit: f.selSubmit },
    ...(f.username.trim() ? { username: f.username } : {}),
    ...(f.password ? { password: f.password } : {}),
  };
  try {
    if (siteEditing.value) await api(`/credentials/${siteEditing.value.credentialId}`, { method: 'PATCH', body });
    else await api('/credentials/website', { method: 'POST', body: { ...body, name: f.name, department: f.department.trim() || null, username: f.username, password: f.password } });
    toast(siteEditing.value ? 'Website login updated' : 'Website login saved', 'success');
    showSite.value = false;
    store.load(true);
  } catch (err) {
    toastError(err);
  } finally {
    busy.value = null;
  }
}

/* ---------- AI service ---------- */
const showAi = ref(false);
const aiForm = ref({ service: 'openai' as AiService, name: 'OpenAI', apiKey: '', model: AI_SERVICE_INFO.openai.defaultModel, department: '' });
function pickService(s: AiService) {
  const wasDefaultName = AI_SERVICES.some((x) => aiForm.value.name === AI_SERVICE_INFO[x].label.split(' (')[0]) || !aiForm.value.name;
  aiForm.value.service = s;
  aiForm.value.model = AI_SERVICE_INFO[s].defaultModel;
  if (wasDefaultName) aiForm.value.name = AI_SERVICE_INFO[s].label.split(' (')[0]!;
}
async function createAi() {
  busy.value = 'ai';
  try {
    const c = await api<Credential>('/credentials/ai', { method: 'POST', body: { ...aiForm.value, department: aiForm.value.department.trim() || null } });
    toast(`AI connected: ${c.lastTestResult ?? c.name}`, 'success');
    showAi.value = false;
    aiForm.value.apiKey = '';
    store.load(true);
  } catch (err) {
    toastError(err);
  } finally {
    busy.value = null;
  }
}
const aiEditing = ref<Credential | null>(null);
const aiEdit = ref({ model: '', apiKey: '' });
function openAiEdit(c: Credential) {
  aiEditing.value = c;
  aiEdit.value = { model: c.details.model ?? '', apiKey: '' };
}
async function saveAiEdit() {
  if (!aiEditing.value) return;
  busy.value = 'ai-edit';
  try {
    await api(`/credentials/${aiEditing.value.credentialId}`, { method: 'PATCH', body: { model: aiEdit.value.model, ...(aiEdit.value.apiKey.trim() ? { apiKey: aiEdit.value.apiKey } : {}) } });
    toast('AI connection updated and tested', 'success');
    aiEditing.value = null;
    store.load(true);
  } catch (err) {
    toastError(err);
  } finally {
    busy.value = null;
  }
}

/* ---------- Firebase ---------- */
const showFirebase = ref(false);
const fb = ref({ name: '', department: '', serviceAccountJson: '', collections: '', readOnly: false });
async function readFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) fb.value.serviceAccountJson = await file.text();
}
async function createFirebase() {
  busy.value = 'firebase';
  try {
    const c = await api<Credential>('/credentials/firebase', {
      method: 'POST',
      body: {
        name: fb.value.name,
        department: fb.value.department.trim() || null,
        serviceAccountJson: fb.value.serviceAccountJson,
        allowedCollections: fb.value.collections.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
        readOnly: fb.value.readOnly,
      },
    });
    showFirebase.value = false;
    fb.value = { name: '', department: '', serviceAccountJson: '', collections: '', readOnly: false };
    await store.load(true);
    await test(c);
  } catch (err) {
    toastError(err);
  } finally {
    busy.value = null;
  }
}

/* ---------- Google ---------- */
const showGoogle = ref(false);
const g = ref({ name: '', department: '' });
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
/** Older Google connections were made before Google Sheets existed here. */
const needsSheets = (c: Credential) => c.provider === 'google_oauth' && !(c.details.scopes ?? []).includes(SHEETS_SCOPE);

/** Same connection, new sign-in (new permissions). Workflows that use it keep working. */
async function reconnectGoogle(c: Credential) {
  busy.value = c.credentialId;
  try {
    const { url } = await api<{ url: string }>('/credentials/google/start', { method: 'POST', body: { name: c.name, department: c.department, reconnectId: c.credentialId } });
    window.location.href = url;
  } catch (err) {
    toastError(err);
    busy.value = null;
  }
}

async function connectGoogle() {
  busy.value = 'google';
  try {
    const { url } = await api<{ url: string }>('/credentials/google/start', { method: 'POST', body: { name: g.value.name, department: g.value.department.trim() || null } });
    window.location.href = url; // Google sign-in, then back to /credentials
  } catch (err) {
    toastError(err);
    busy.value = null;
  }
}

/* ---------- Event source ---------- */
const showEvent = ref(false);
const evName = ref('');
const issuedKey = ref<{ name: string; key: string } | null>(null);
async function createEventSource() {
  busy.value = 'event';
  try {
    const res = await api<{ credential: Credential; key: string }>('/credentials/event-source', { method: 'POST', body: { name: evName.value } });
    showEvent.value = false;
    issuedKey.value = { name: res.credential.name, key: res.key };
    evName.value = '';
    store.load(true);
  } catch (err) {
    toastError(err);
  } finally {
    busy.value = null;
  }
}
async function rotate(c: Credential) {
  if (!confirm(`Create a new key for “${c.name}”? The current key stops working immediately.`)) return;
  try {
    const res = await api<{ key: string }>(`/credentials/${c.credentialId}/rotate`, { method: 'POST' });
    issuedKey.value = { name: c.name, key: res.key };
    store.load(true);
  } catch (err) {
    toastError(err);
  }
}

/* ---------- common ---------- */
async function test(c: Credential) {
  busy.value = c.credentialId;
  try {
    const r = await api<{ ok: boolean; message: string }>(`/credentials/${c.credentialId}/test`, { method: 'POST' });
    toast(r.message, r.ok ? 'success' : 'error', 6000);
    await store.load(true);
  } catch (err) {
    toastError(err);
  } finally {
    busy.value = null;
  }
}
const editing = ref<Credential | null>(null);
const editCollections = ref('');
const editReadOnly = ref(false);
function openEdit(c: Credential) {
  editing.value = c;
  editCollections.value = (c.details.allowedCollections ?? []).join('\n');
  editReadOnly.value = !!c.details.readOnly;
}
async function saveEdit() {
  if (!editing.value) return;
  try {
    await api(`/credentials/${editing.value.credentialId}`, {
      method: 'PATCH',
      body: { allowedCollections: editCollections.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean), readOnly: editReadOnly.value },
    });
    editing.value = null;
    toast('Access updated', 'success');
    store.load(true);
  } catch (err) {
    toastError(err);
  }
}
async function remove(c: Credential) {
  if (!confirm(`Delete “${c.name}”? Workflows using it will fail until you choose another connection.`)) return;
  try {
    await api(`/credentials/${c.credentialId}`, { method: 'DELETE' });
    toast('Connection deleted', 'success');
    store.load(true);
  } catch (err) {
    toastError(err);
  }
}
const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast('Copied', 'success', 1500));
const origin = window.location.origin;

onMounted(async () => {
  if (route.query.connected) toast(`Connected “${route.query.connected}”`, 'success');
  if (route.query.error) toast(`Google connection failed: ${route.query.error}`, 'error', 8000);
  if (route.query.connected || route.query.error) router.replace('/credentials');
  // Opened from the Integrations page: show the right "connect" form straight away.
  const add = String(route.query.add ?? '');
  if (canManage.value && add) {
    if (add === 'google') showGoogle.value = true;
    else if (add === 'firebase') showFirebase.value = true;
    else if (add === 'event') showEvent.value = true;
    else if (add === 'website') openSite();
    else if (add === 'api-key') openKey();
    else if ((AI_SERVICES as readonly string[]).includes(add)) (pickService(add as AiService), (showAi.value = true));
    router.replace('/credentials');
  }
  try {
    await store.load(true);
  } catch (err) {
    toastError(err);
  }
});
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1100px] mx-auto">
    <PageHeader title="Credentials" subtitle="Connections to other systems. Secrets are encrypted on the server and never shown again.">
      <div v-if="canManage" class="flex flex-wrap gap-2">
        <button class="btn-secondary" @click="showFirebase = true"><Database class="size-4" />Firebase project</button>
        <button class="btn-secondary" @click="showGoogle = true"><Mail class="size-4" />Google account</button>
        <button class="btn-secondary" @click="showEvent = true"><Radio class="size-4" />Event source</button>
        <button class="btn-secondary" @click="showAi = true"><Bot class="size-4" />AI service</button>
        <button class="btn-secondary" @click="openSite()"><GlobeLock class="size-4" />Website login</button>
        <button class="btn-secondary" @click="openKey()"><KeySquare class="size-4" />API key / token</button>
      </div>
    </PageHeader>

    <div class="card">
      <Skeleton v-if="!store.loaded" kind="list" :rows="3" />
      <EmptyState v-else-if="!store.items.length" :icon="KeyRound" title="No connections yet" :text="canManage ? 'Add a Firebase project, a Google account or an event source.' : 'An IT Admin adds connections here.'" />
      <ul v-else>
        <li v-for="(c, idx) in store.items" :key="c.credentialId" :style="{ '--i': idx }" class="animate-in flex flex-wrap items-center gap-4 px-4 py-3 border-b border-line last:border-0">
          <span class="size-9 rounded-md bg-brand-soft text-brand grid place-items-center shrink-0"><component :is="icons[c.provider]" class="size-4" /></span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="font-medium">{{ c.name }}</span>
              <StatusBadge :status="c.status === 'connected' ? 'active' : c.status === 'error' ? 'failed' : 'pending'" />
              <span class="chip">{{ c.department ?? 'All departments' }}</span>
            </div>
            <div class="text-[12px] text-subtle mt-0.5 truncate">
              {{ PROVIDER_LABELS[c.provider] }}
              <template v-if="c.details.projectId"> · {{ c.details.projectId }} · {{ c.details.readOnly ? 'read-only' : 'read & write' }} · {{ c.details.allowedCollections?.join(', ') }}</template>
              <template v-if="c.details.accountEmail"> · {{ c.details.accountEmail }}</template>
              <template v-if="c.details.keyPrefix"> · key {{ c.details.keyPrefix }}…</template>
              <template v-if="c.details.aiService"> · {{ AI_SERVICE_INFO[c.details.aiService].label }} · model {{ c.details.model }} · key …{{ c.details.keyEnding }}</template>
              <template v-if="c.provider === 'website_login'"> · {{ c.details.allowedDomains?.join(', ') }} · user {{ c.details.usernameHint }}</template>
              <template v-if="c.provider === 'api_key'"> · {{ c.details.headerName }} → {{ c.details.allowedDomains?.join(', ') }}<template v-if="c.details.keyEnding"> · key …{{ c.details.keyEnding }}</template></template>
            </div>
            <div v-if="c.lastTestedAt" class="text-[11px] mt-0.5" :class="c.status === 'error' ? 'text-bad' : 'text-subtle'">Tested {{ timeAgo(c.lastTestedAt) }}: {{ c.lastTestResult }}</div>
            <div v-if="needsSheets(c)" class="text-[12px] mt-1 text-warn">Click <b>Reconnect</b> to also allow Google Sheets for this account.</div>
          </div>
          <div v-if="canManage" class="flex gap-1">
            <button v-if="c.provider !== 'event_source'" class="btn-ghost h-7 text-[12px]" :disabled="busy === c.credentialId" @click="test(c)">
              <RefreshCw class="size-3.5" :class="{ 'animate-spin': busy === c.credentialId }" />Test
            </button>
            <button v-if="c.provider === 'google_oauth'" class="btn-ghost h-7 text-[12px]" :class="{ 'text-warn': needsSheets(c) }" :disabled="busy === c.credentialId" title="Sign in to Google again (same connection)" @click="reconnectGoogle(c)">Reconnect</button>
            <button v-if="c.provider === 'firebase_service_account'" class="btn-ghost h-7 text-[12px]" @click="openEdit(c)">Access</button>
            <button v-if="c.provider === 'ai_provider'" class="btn-ghost h-7 text-[12px]" @click="openAiEdit(c)">Edit</button>
            <button v-if="c.provider === 'website_login'" class="btn-ghost h-7 text-[12px]" @click="openSite(c)">Edit</button>
            <button v-if="c.provider === 'api_key'" class="btn-ghost h-7 text-[12px]" @click="openKey(c)">Edit</button>
            <button v-if="c.provider === 'event_source'" class="btn-ghost h-7 text-[12px]" @click="rotate(c)">New key</button>
            <button class="btn-ghost h-7 text-[12px] text-bad hover:bg-bad-soft" aria-label="Delete" @click="remove(c)"><Trash2 class="size-3.5" /></button>
          </div>
        </li>
      </ul>
    </div>

    <!-- Firebase -->
    <Modal v-if="showFirebase" title="Connect a Firebase project" width="560px" @close="showFirebase = false">
      <form id="fb-form" class="space-y-4" @submit.prevent="createFirebase">
        <div class="grid grid-cols-2 gap-3">
          <div><label class="label">Name</label><input v-model="fb.name" class="input" required placeholder="Widebed PMS" /></div>
          <div><label class="label">Department (empty = all)</label><input v-model="fb.department" class="input" placeholder="Operations" /></div>
        </div>
        <div>
          <label class="label">Service account key (JSON)</label>
          <label class="btn-secondary w-full cursor-pointer"><Upload class="size-4" />{{ fb.serviceAccountJson ? 'Key loaded — choose another file' : 'Choose the .json file' }}<input type="file" accept=".json,application/json" class="hidden" @change="readFile" /></label>
          <p class="text-[11px] text-subtle mt-1">Firebase console of that project → Project settings → Service accounts → Generate new private key. Delete the downloaded file after uploading.</p>
        </div>
        <div>
          <label class="label">Collections the nodes may use (one per line)</label>
          <textarea v-model="fb.collections" class="textarea font-mono text-[12px]" rows="4" required placeholder="bookings&#10;tenants&#10;tenants/*/payments" />
          <p class="text-[11px] text-subtle mt-1">Everything else in that project stays unreachable. <code>*</code> matches one ID in a sub-collection path.</p>
        </div>
        <label class="flex items-center gap-2 text-[13px]"><input v-model="fb.readOnly" type="checkbox" class="accent-[var(--wb-brand)]" />Read-only (Firebase Create / Update / Delete will be refused)</label>
      </form>
      <template #footer>
        <button class="btn-secondary" @click="showFirebase = false">Cancel</button>
        <button class="btn-primary" form="fb-form" type="submit" :disabled="busy === 'firebase' || !fb.serviceAccountJson"><Plug class="size-4" />Connect and test</button>
      </template>
    </Modal>

    <!-- Google -->
    <Modal v-if="showGoogle" title="Connect a Google account (Gmail)" width="520px" @close="showGoogle = false">
      <div v-if="!store.google.configured" class="rounded-md bg-warn-soft text-warn text-[13px] p-3 leading-relaxed">
        Google sign-in is not configured on the server yet. Set <code>GOOGLE_OAUTH_CLIENT_ID</code> and <code>GOOGLE_OAUTH_CLIENT_SECRET</code>
        and add this redirect URI to the OAuth client:
        <div class="flex gap-1.5 mt-2"><input class="input font-mono text-[12px]" readonly :value="store.google.redirectUri" /><button class="btn-secondary btn-icon" @click="copy(store.google.redirectUri)"><Copy class="size-4" /></button></div>
      </div>
      <form v-else id="g-form" class="space-y-4" @submit.prevent="connectGoogle">
        <div class="grid grid-cols-2 gap-3">
          <div><label class="label">Name</label><input v-model="g.name" class="input" required placeholder="Support inbox" /></div>
          <div><label class="label">Department (empty = all)</label><input v-model="g.department" class="input" /></div>
        </div>
        <p class="text-[12px] text-muted">You will be sent to Google. Sign in with the account workflows should use (send/read email, read/write Google Sheets), then allow access.</p>
      </form>
      <template #footer>
        <button class="btn-secondary" @click="showGoogle = false">Cancel</button>
        <button v-if="store.google.configured" class="btn-primary" form="g-form" type="submit" :disabled="busy === 'google'"><Mail class="size-4" />Continue to Google</button>
      </template>
    </Modal>

    <!-- AI service -->
    <Modal v-if="showAi" title="Connect an AI service" width="560px" @close="showAi = false">
      <form id="ai-form" class="space-y-4" @submit.prevent="createAi">
        <div>
          <label class="label">Which AI service?</label>
          <div class="grid grid-cols-3 gap-2">
            <button
              v-for="s in AI_SERVICES"
              :key="s"
              type="button"
              class="rounded-md border p-2.5 text-left text-[13px] transition-colors"
              :class="aiForm.service === s ? 'border-brand bg-brand-soft text-brand font-medium' : 'border-line hover:border-line-strong'"
              @click="pickService(s)"
            >
              {{ AI_SERVICE_INFO[s].label }}
            </button>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="label">Name</label><input v-model="aiForm.name" class="input" required maxlength="80" /></div>
          <div><label class="label">Department (empty = all)</label><input v-model="aiForm.department" class="input" /></div>
        </div>
        <div>
          <label class="label">API key</label>
          <input v-model="aiForm.apiKey" type="password" class="input font-mono" required autocomplete="off" :placeholder="AI_SERVICE_INFO[aiForm.service].keyHint" />
          <a :href="AI_SERVICE_INFO[aiForm.service].keyUrl" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[12px] text-brand mt-1">Get a key from {{ AI_SERVICE_INFO[aiForm.service].label }} <ExternalLink class="size-3" /></a>
        </div>
        <div>
          <label class="label">Model</label>
          <input v-model="aiForm.model" class="input font-mono" list="ai-models" maxlength="100" />
          <datalist id="ai-models"><option v-for="m in AI_SERVICE_INFO[aiForm.service].models" :key="m" :value="m" /></datalist>
          <p class="text-[11px] text-subtle mt-1">The first suggestion is a good, low-cost choice. We send one tiny test message to check the key and model before saving.</p>
        </div>
        <div class="rounded-md bg-info-soft text-info text-[12px] p-2.5 leading-relaxed">
          The key is encrypted on the server and never shown again. AI services charge per use — set a monthly spending limit in your AI account.
        </div>
      </form>
      <template #footer>
        <button class="btn-secondary" @click="showAi = false">Cancel</button>
        <button class="btn-primary" form="ai-form" type="submit" :disabled="busy === 'ai'"><RefreshCw v-if="busy === 'ai'" class="size-4 animate-spin" /><Plug v-else class="size-4" />Test and connect</button>
      </template>
    </Modal>

    <Modal v-if="aiEditing" :title="`Edit ${aiEditing.name}`" @close="aiEditing = null">
      <form id="ai-edit" class="space-y-4" @submit.prevent="saveAiEdit">
        <div>
          <label class="label">Model</label>
          <input v-model="aiEdit.model" class="input font-mono" list="ai-edit-models" maxlength="100" />
          <datalist id="ai-edit-models"><option v-for="m in AI_SERVICE_INFO[aiEditing.details.aiService ?? 'openai'].models" :key="m" :value="m" /></datalist>
        </div>
        <div>
          <label class="label">New API key (leave empty to keep the current one)</label>
          <input v-model="aiEdit.apiKey" type="password" class="input font-mono" autocomplete="off" />
        </div>
      </form>
      <template #footer>
        <button class="btn-secondary" @click="aiEditing = null">Cancel</button>
        <button class="btn-primary" form="ai-edit" type="submit" :disabled="busy === 'ai-edit'">Test and save</button>
      </template>
    </Modal>

    <!-- Website login -->
    <Modal v-if="showSite" :title="siteEditing ? `Edit ${siteEditing.name}` : 'Save a website login for the assistant'" width="580px" @close="showSite = false">
      <form id="site-form" class="space-y-4" @submit.prevent="saveSite">
        <p class="text-[12.5px] text-muted -mt-1">The assistant’s browser signs in with this when you ask it to (e.g. “get my TNB bills”). The password is encrypted and the AI never sees it.</p>
        <div v-if="!siteEditing" class="grid grid-cols-2 gap-3">
          <div><label class="label">Name</label><input v-model="site.name" class="input" required maxlength="80" placeholder="myTNB" /></div>
          <div><label class="label">Department (empty = all)</label><input v-model="site.department" class="input" /></div>
        </div>
        <div>
          <label class="label">Login page address</label>
          <input v-model="site.loginUrl" class="input font-mono text-[12px]" required placeholder="https://www.mytnb.com.my/…" />
          <p class="text-[11px] text-subtle mt-1">Open the website’s sign-in page in your browser and copy the address bar.</p>
        </div>
        <div>
          <label class="label">Other websites it may open (optional)</label>
          <input v-model="site.otherSites" class="input font-mono text-[12px]" placeholder="mytnb.com.my, tnb.com.my" />
          <p class="text-[11px] text-subtle mt-1">The assistant can never open any other website.</p>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="label">Username / email</label><input v-model="site.username" class="input" :required="!siteEditing" autocomplete="off" :placeholder="siteEditing?.details.usernameHint ?? ''" /></div>
          <div><label class="label">Password</label><input v-model="site.password" type="password" class="input" :required="!siteEditing" autocomplete="new-password" :placeholder="siteEditing ? 'leave empty to keep' : ''" /></div>
        </div>
        <details class="text-[12.5px]">
          <summary class="cursor-pointer text-muted">Advanced (for IT): login page fields</summary>
          <p class="text-[11px] text-subtle mt-2 mb-2">Only if the assistant cannot find the fields by itself. Use the words shown on the page (e.g. Email, Password, Login) or CSS (e.g. #email).</p>
          <div class="grid grid-cols-3 gap-2">
            <input v-model="site.selUser" class="input font-mono text-[12px]" placeholder="username field" />
            <input v-model="site.selPass" class="input font-mono text-[12px]" placeholder="password field" />
            <input v-model="site.selSubmit" class="input font-mono text-[12px]" placeholder="sign-in button" />
          </div>
        </details>
        <div class="rounded-md bg-warn-soft text-warn text-[12px] p-2.5 leading-relaxed">
          Check that the website allows automated sign-in. If it sends a code (OTP) by SMS, the assistant will ask you for it in the chat.
        </div>
      </form>
      <template #footer>
        <button class="btn-secondary" @click="showSite = false">Cancel</button>
        <button class="btn-primary" form="site-form" type="submit" :disabled="busy === 'site'"><GlobeLock class="size-4" />Save</button>
      </template>
    </Modal>

    <!-- API key / token -->
    <Modal v-if="showKey" :title="keyEditing ? `Edit ${keyEditing.name}` : 'Save an API key or token'" width="560px" @close="showKey = false">
      <form id="key-form" class="space-y-4" @submit.prevent="saveKey">
        <p class="text-[12.5px] text-muted -mt-1">For <b>HTTP Request</b> steps that call another system (e.g. GoHighLevel). Choose it in the step’s <i>Sign in with</i>. The key is encrypted and never shown again.</p>
        <div v-if="!keyEditing" class="grid grid-cols-2 gap-3">
          <div><label class="label">Name</label><input v-model="keyForm.name" class="input" required maxlength="80" placeholder="GoHighLevel" /></div>
          <div><label class="label">Department (empty = all)</label><input v-model="keyForm.department" class="input" /></div>
        </div>
        <div>
          <label class="label">Websites it may be sent to</label>
          <input v-model="keyForm.sites" class="input font-mono text-[12px]" required placeholder="services.leadconnectorhq.com" />
          <p class="text-[11px] text-subtle mt-1">The key is never sent anywhere else, even if a step’s address is changed by mistake.</p>
        </div>
        <div class="grid grid-cols-[1fr_2fr] gap-3">
          <div><label class="label">Header name</label><input v-model="keyForm.headerName" class="input font-mono text-[12px]" maxlength="64" placeholder="Authorization" /></div>
          <div>
            <label class="label">Key or token</label>
            <input v-model="keyForm.value" type="password" class="input font-mono" :required="!keyEditing" autocomplete="off" :placeholder="keyEditing ? 'leave empty to keep' : 'pit-…'" />
          </div>
        </div>
        <label v-if="/^authorization$/i.test(keyForm.headerName.trim())" class="flex items-center gap-2 text-[13px]">
          <input v-model="keyForm.bearer" type="checkbox" class="accent-[var(--wb-brand)]" />Add “Bearer ” in front (most APIs, e.g. GoHighLevel private integration tokens)
        </label>
      </form>
      <template #footer>
        <button class="btn-secondary" @click="showKey = false">Cancel</button>
        <button class="btn-primary" form="key-form" type="submit" :disabled="busy === 'key'"><KeySquare class="size-4" />Save</button>
      </template>
    </Modal>

    <!-- Event source -->
    <Modal v-if="showEvent" title="New event source" @close="showEvent = false">
      <form id="ev-form" @submit.prevent="createEventSource">
        <label class="label">Which app will send events?</label>
        <input v-model="evName" class="input" required placeholder="Widebed PMS" />
        <p class="text-[12px] text-muted mt-2">Each app gets its own key, so you can replace one without touching the others.</p>
      </form>
      <template #footer>
        <button class="btn-secondary" @click="showEvent = false">Cancel</button>
        <button class="btn-primary" form="ev-form" type="submit" :disabled="busy === 'event'">Create key</button>
      </template>
    </Modal>

    <Modal v-if="issuedKey" :title="`Key for ${issuedKey.name}`" width="620px" @close="issuedKey = null">
      <div class="rounded-md bg-warn-soft text-warn text-[12px] p-2.5 mb-4">Copy this key now — it will not be shown again. Store it in the app’s server settings, never in browser code.</div>
      <div class="flex gap-1.5"><input class="input font-mono text-[12px]" readonly :value="issuedKey.key" /><button class="btn-secondary btn-icon" @click="copy(issuedKey.key)"><Copy class="size-4" /></button></div>
      <label class="label mt-4">Example request from the app</label>
      <pre class="font-mono text-[11.5px] bg-surface-2 border border-line rounded-md p-3 whitespace-pre-wrap break-all">POST {{ origin }}/events/booking.created
Authorization: Bearer {{ issuedKey.key }}
Content-Type: application/json
Idempotency-Key: booking-B-102

{ "bookingId": "B-102", "nights": 3 }</pre>
      <template #footer><button class="btn-primary" @click="issuedKey = null">Done</button></template>
    </Modal>

    <!-- Firebase access -->
    <Modal v-if="editing" :title="`Access for ${editing.name}`" @close="editing = null">
      <label class="label">Allowed collections (one per line)</label>
      <textarea v-model="editCollections" class="textarea font-mono text-[12px]" rows="5" />
      <label class="flex items-center gap-2 text-[13px] mt-3"><input v-model="editReadOnly" type="checkbox" class="accent-[var(--wb-brand)]" />Read-only</label>
      <template #footer>
        <button class="btn-secondary" @click="editing = null">Cancel</button>
        <button class="btn-primary" @click="saveEdit">Save</button>
      </template>
    </Modal>
  </div>
</template>
