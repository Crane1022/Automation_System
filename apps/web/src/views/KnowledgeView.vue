<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { BookOpen, FileText, Folder, FolderOpen, Keyboard, Loader2, Pencil, Plus, Search, Sparkles, Trash2, Upload, Users } from '@lucide/vue';
import type { AgentSummary, KnowledgeDoc, KnowledgeHit, PersonSummary, Role } from '@widebed/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import Modal from '@/components/ui/Modal.vue';
import AgentAvatar from '@/components/ai/AgentAvatar.vue';
import { READABLE_FILES, api, apiUpload } from '@/lib/api';
import { roleLabels, timeAgo } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';

/**
 * Company Knowledge: documents AI Staff look up before answering.
 * Only the text is saved (uploaded files are read, then thrown away).
 */
const docs = ref<KnowledgeDoc[]>([]);
const canManage = ref(false);
const agents = ref<AgentSummary[]>([]);
const people = ref<PersonSummary[]>([]);
const loading = ref(true);
const folder = ref<string | null>(null);

async function load(quiet = false) {
  try {
    const [k, a, p] = await Promise.all([
      api<{ items: KnowledgeDoc[]; canManage: boolean }>('/knowledge', { quiet }),
      agents.value.length ? null : api<{ items: AgentSummary[] }>('/agents', { quiet: true }).catch(() => ({ items: [] })),
      people.value.length ? null : api<{ items: PersonSummary[] }>('/people', { quiet: true }).catch(() => ({ items: [] })),
    ]);
    docs.value = k.items;
    canManage.value = k.canManage;
    if (a) agents.value = a.items;
    if (p) people.value = p.items;
  } catch (err) {
    if (!quiet) toastError(err);
  } finally {
    loading.value = false;
  }
}
onMounted(() => load());

const folders = computed(() => {
  const m = new Map<string, number>();
  for (const d of docs.value) m.set(d.folder, (m.get(d.folder) ?? 0) + 1);
  return [...m.entries()].filter(([f]) => f).sort((a, b) => a[0].localeCompare(b[0]));
});
const shown = computed(() => (folder.value === null ? docs.value : docs.value.filter((d) => d.folder === folder.value)));
const departments = computed(() => [...new Set(people.value.map((p) => p.department).filter(Boolean))].sort() as string[]);
const agentName = (id: string) => agents.value.find((a) => a.agentId === id)?.name ?? 'Removed AI employee';
const readers = (d: KnowledgeDoc) =>
  d.audience.everyone ? 'Everyone' : [...d.audience.departments, ...d.audience.roles.map((r) => `${roleLabels[r] ?? r}s`)].join(', ');
const aiList = (d: KnowledgeDoc) => (d.agentIds.length ? d.agentIds.map(agentName).join(', ') : 'All AI staff');
const size = (chars: number) => (chars >= 1000 ? `${Math.round(chars / 100) / 10}k characters` : `${chars} characters`);

/* ---------------------------------------------------------------- try a search */
const q = ref('');
const qAgent = ref('');
const hits = ref<KnowledgeHit[] | null>(null);
const searching = ref(false);
async function search() {
  if (!q.value.trim()) {
    hits.value = null;
    return;
  }
  searching.value = true;
  try {
    hits.value = (await api<{ items: KnowledgeHit[] }>('/knowledge/search', { query: { q: q.value, agentId: qAgent.value }, quiet: true })).items;
  } catch (err) {
    toastError(err);
  } finally {
    searching.value = false;
  }
}

/* ---------------------------------------------------------------- open / read */
const reading = ref<{ doc: KnowledgeDoc; text: string } | null>(null);
async function open(d: KnowledgeDoc) {
  try {
    reading.value = await api<{ doc: KnowledgeDoc; text: string }>(`/knowledge/${d.docId}`);
  } catch (err) {
    toastError(err);
  }
}

/* ---------------------------------------------------------------- add / edit */
interface Form {
  docId: string | null;
  title: string;
  folder: string;
  text: string;
  everyone: boolean;
  departments: string[];
  roles: Role[];
  allAgents: boolean;
  agentIds: string[];
  source: 'typed' | 'upload';
  fileName: string | null;
  fileKind: string | null;
  textChanged: boolean;
}
const editing = ref<Form | null>(null);
const mode = ref<'type' | 'upload'>('type');
const extracting = ref(false);
const saving = ref(false);
const fileEl = ref<HTMLInputElement | null>(null);
const ROLE_CHOICES: Role[] = ['admin', 'it_admin', 'department_manager', 'employee'];

function startAdd() {
  mode.value = 'type';
  editing.value = { docId: null, title: '', folder: folder.value ?? '', text: '', everyone: true, departments: [], roles: [], allAgents: true, agentIds: [], source: 'typed', fileName: null, fileKind: null, textChanged: true };
}
async function startEdit(d: KnowledgeDoc) {
  try {
    const full = await api<{ doc: KnowledgeDoc; text: string }>(`/knowledge/${d.docId}`);
    reading.value = null;
    mode.value = 'type';
    editing.value = {
      docId: d.docId,
      title: d.title,
      folder: d.folder,
      text: full.text,
      everyone: d.audience.everyone,
      departments: [...d.audience.departments],
      roles: [...d.audience.roles],
      allAgents: !d.agentIds.length,
      agentIds: [...d.agentIds],
      source: d.source,
      fileName: d.fileName,
      fileKind: d.fileKind,
      textChanged: false,
    };
  } catch (err) {
    toastError(err);
  }
}
async function pickFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f || !editing.value) return;
  if (f.size > 10 * 1024 * 1024) return toast('The file is larger than 10 MB. Split it, or paste the important part as text.', 'error');
  extracting.value = true;
  try {
    const r = await apiUpload<{ name: string; kind: string; text: string; chars: number }>('/knowledge/extract', f, { name: f.name });
    const ed = editing.value;
    ed.text = r.text;
    ed.textChanged = true;
    ed.source = 'upload';
    ed.fileName = r.name;
    ed.fileKind = r.kind;
    if (!ed.title) ed.title = r.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    mode.value = 'type';
    toast(`Read ${size(r.chars)} from ${r.name}. Check the text below, then save.`, 'success');
  } catch (err) {
    toastError(err);
  } finally {
    extracting.value = false;
  }
}
const toggle = <T,>(list: T[], v: T) => {
  const i = list.indexOf(v);
  if (i >= 0) list.splice(i, 1);
  else list.push(v);
};
const formProblem = computed(() => {
  const f = editing.value;
  if (!f) return '';
  if (!f.title.trim()) return 'Give it a title.';
  if (!f.text.trim()) return 'Add the text (type it, or choose a file).';
  if (!f.everyone && !f.departments.length && !f.roles.length) return 'Choose who may read it.';
  if (!f.allAgents && !f.agentIds.length) return 'Choose at least one AI employee, or “All AI staff”.';
  return '';
});
async function save() {
  const f = editing.value;
  if (!f || formProblem.value) return;
  saving.value = true;
  const body = {
    title: f.title.trim(),
    folder: f.folder.trim(),
    audience: { everyone: f.everyone, departments: f.everyone ? [] : f.departments, roles: f.everyone ? [] : f.roles },
    agentIds: f.allAgents ? [] : f.agentIds,
  };
  try {
    if (f.docId) await api(`/knowledge/${f.docId}`, { method: 'PATCH', body: { ...body, ...(f.textChanged ? { text: f.text } : {}) } });
    else await api('/knowledge', { method: 'POST', body: { ...body, text: f.text, source: f.source, fileName: f.fileName, fileKind: f.fileKind } });
    toast(f.docId ? 'Saved' : 'Added — AI staff can use it now', 'success');
    editing.value = null;
    hits.value = null;
    await load(true);
  } catch (err) {
    toastError(err);
  } finally {
    saving.value = false;
  }
}
async function remove(d: KnowledgeDoc) {
  if (!confirm(`Remove “${d.title}”?\n\nAI staff will stop using it. This can’t be undone.`)) return;
  try {
    await api(`/knowledge/${d.docId}`, { method: 'DELETE' });
    reading.value = null;
    docs.value = docs.value.filter((x) => x.docId !== d.docId);
    toast('Removed', 'success');
  } catch (err) {
    toastError(err);
  }
}
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1180px] mx-auto">
    <PageHeader title="Company Knowledge" subtitle="SOPs, house rules, price lists and policies. AI staff look here before answering — only the text is saved, never the files." guide="knowledge">
      <button v-if="canManage" class="btn-primary" @click="startAdd"><Plus class="size-4" />Add document</button>
    </PageHeader>

    <!-- Try a search -->
    <div class="card p-4 mb-5 animate-in">
      <form class="flex flex-wrap items-center gap-2" @submit.prevent="search">
        <div class="relative flex-1 min-w-[220px]">
          <Search class="size-4 text-subtle absolute left-3 top-1/2 -translate-y-1/2" />
          <input v-model="q" class="input pl-9" placeholder="Try a search, e.g. “late checkout fee” — see what the AI would find" maxlength="300" />
        </div>
        <select v-model="qAgent" class="input w-auto" aria-label="As which AI employee">
          <option value="">Any AI employee</option>
          <option v-for="a in agents" :key="a.agentId" :value="a.agentId">As {{ a.name }}</option>
        </select>
        <button class="btn-secondary" :disabled="searching">
          <Loader2 v-if="searching" class="size-4 animate-spin" /><Sparkles v-else class="size-4" />Search
        </button>
      </form>
      <div v-if="hits" class="mt-3 space-y-2 animate-in">
        <p v-if="!hits.length" class="text-[13px] text-muted">Nothing found. The AI would say there is no document about this.</p>
        <button v-for="h in hits" :key="`${h.docId}-${h.index}`" class="w-full text-left rounded-lg border border-line p-3 hover:border-brand transition-colors" @click="open(docs.find((d) => d.docId === h.docId)!)">
          <div class="flex items-center gap-2 text-[13px]">
            <FileText class="size-3.5 text-brand" /><span class="font-medium">{{ h.title }}</span>
            <span class="text-subtle text-[11.5px]">part {{ h.index + 1 }} of {{ h.of }}{{ h.folder ? ` · ${h.folder}` : '' }}</span>
          </div>
          <p class="text-[12.5px] text-muted mt-1 line-clamp-3 whitespace-pre-wrap">{{ h.text }}</p>
        </button>
      </div>
    </div>

    <Skeleton v-if="loading" kind="list" :rows="4" />
    <div v-else-if="!docs.length" class="card">
      <EmptyState :icon="BookOpen" title="No documents yet" :text="canManage ? 'Add your house rules, cleaning SOP or price list. Type it, or upload a PDF / Word / Excel file.' : 'Your Admin hasn’t added any company documents you can read yet.'">
        <button v-if="canManage" class="btn-primary" @click="startAdd"><Plus class="size-4" />Add the first document</button>
      </EmptyState>
    </div>

    <div v-else class="grid md:grid-cols-[200px_1fr] gap-5">
      <!-- folders -->
      <nav class="space-y-0.5 text-[13px]">
        <button class="w-full flex items-center gap-2 rounded-md px-2.5 h-8 hover:bg-surface-2" :class="folder === null ? 'bg-brand-soft text-brand font-medium' : ''" @click="folder = null">
          <BookOpen class="size-4" />All documents<span class="ml-auto text-subtle text-[11.5px]">{{ docs.length }}</span>
        </button>
        <button v-for="[f, n] in folders" :key="f" class="w-full flex items-center gap-2 rounded-md px-2.5 h-8 hover:bg-surface-2" :class="folder === f ? 'bg-brand-soft text-brand font-medium' : ''" @click="folder = f">
          <FolderOpen v-if="folder === f" class="size-4" /><Folder v-else class="size-4" /><span class="truncate">{{ f }}</span><span class="ml-auto text-subtle text-[11.5px]">{{ n }}</span>
        </button>
      </nav>

      <!-- documents -->
      <TransitionGroup name="list" tag="div" class="grid sm:grid-cols-2 gap-3 content-start">
        <article v-for="(d, i) in shown" :key="d.docId" class="card p-4 lift cursor-pointer animate-in flex flex-col" :style="{ '--i': Math.min(i, 8) }" @click="open(d)">
          <div class="flex items-start gap-2">
            <div class="size-8 rounded-lg bg-brand-soft text-brand grid place-items-center shrink-0"><FileText class="size-4" /></div>
            <div class="min-w-0 flex-1">
              <h3 class="font-semibold text-[14px] leading-5 truncate">{{ d.title }}</h3>
              <p class="text-[11.5px] text-subtle">{{ d.folder || 'No folder' }} · {{ size(d.chars) }}{{ d.fileName ? ` · from ${d.fileName}` : '' }}</p>
            </div>
          </div>
          <p class="text-[12.5px] text-muted mt-2 line-clamp-3 whitespace-pre-wrap flex-1">{{ d.preview }}</p>
          <div class="mt-3 flex flex-wrap gap-1.5 text-[11.5px]">
            <span class="chip h-6"><Users class="size-3" />{{ readers(d) }}</span>
            <span class="chip h-6"><Sparkles class="size-3" />{{ aiList(d) }}</span>
          </div>
          <p class="text-[11px] text-subtle mt-2">Updated {{ timeAgo(d.updatedAt) }} · added by {{ d.createdByName }}</p>
        </article>
      </TransitionGroup>
    </div>

    <!-- read one -->
    <Modal v-if="reading" :title="reading.doc.title" width="760px" @close="reading = null">
      <div class="flex flex-wrap gap-1.5 text-[12px] mb-3">
        <span class="chip h-6"><Users class="size-3" />Readers: {{ readers(reading.doc) }}</span>
        <span class="chip h-6"><Sparkles class="size-3" />{{ aiList(reading.doc) }}</span>
        <span class="chip h-6">{{ reading.doc.chunkCount }} {{ reading.doc.chunkCount === 1 ? 'part' : 'parts' }} for searching</span>
      </div>
      <pre class="whitespace-pre-wrap font-sans text-[13px] leading-6 rounded-lg bg-surface-2 p-4 max-h-[55vh] overflow-y-auto">{{ reading.text }}</pre>
      <template v-if="canManage" #footer>
        <button class="btn-ghost text-bad mr-auto" @click="remove(reading.doc)"><Trash2 class="size-4" />Remove</button>
        <button class="btn-primary" @click="startEdit(reading.doc)"><Pencil class="size-4" />Edit</button>
      </template>
    </Modal>

    <!-- add / edit -->
    <Modal v-if="editing" :title="editing.docId ? 'Edit document' : 'Add a document'" width="760px" @close="editing = null">
      <div class="space-y-4 text-[13px]">
        <div class="grid sm:grid-cols-[1fr_220px] gap-3">
          <label class="block"><span class="label">Title</span><input v-model="editing.title" class="input" maxlength="140" placeholder="e.g. House rules" /></label>
          <label class="block">
            <span class="label">Folder</span>
            <input v-model="editing.folder" class="input" list="kb-folders" maxlength="60" placeholder="e.g. Housekeeping" />
            <datalist id="kb-folders"><option v-for="[f] in folders" :key="f" :value="f" /></datalist>
          </label>
        </div>

        <div>
          <div class="flex items-center gap-1 mb-2">
            <button class="chip h-8" :class="mode === 'type' ? 'bg-brand-soft text-brand border-brand' : ''" @click="mode = 'type'"><Keyboard class="size-3.5" />Type or paste</button>
            <button class="chip h-8" :class="mode === 'upload' ? 'bg-brand-soft text-brand border-brand' : ''" @click="mode = 'upload'"><Upload class="size-3.5" />From a file</button>
            <span v-if="editing.fileName" class="ml-auto text-[11.5px] text-subtle truncate">Text from {{ editing.fileName }}</span>
          </div>
          <div v-if="mode === 'upload'" class="rounded-lg border-2 border-dashed border-line p-6 text-center animate-in">
            <input ref="fileEl" type="file" class="hidden" :accept="READABLE_FILES" @change="pickFile" />
            <Loader2 v-if="extracting" class="size-6 animate-spin text-brand mx-auto" />
            <Upload v-else class="size-6 text-subtle mx-auto" />
            <p class="mt-2 font-medium">{{ extracting ? 'Reading the file…' : 'Choose a PDF, Word (.docx), Excel (.xlsx) or text file' }}</p>
            <p class="text-[12px] text-muted mt-1">Up to 10 MB. Only the text is kept — the file is not stored. Scanned PDFs (pictures) can’t be read.</p>
            <button class="btn-secondary mt-3" :disabled="extracting" @click="fileEl?.click()">Choose file</button>
          </div>
          <textarea
            v-else
            v-model="editing.text"
            class="input min-h-[240px] font-mono text-[12.5px] leading-5"
            placeholder="Paste or type the document. Tip: use “# Heading” lines to split it into sections."
            @input="editing.textChanged = true"
          />
          <p v-if="mode === 'type'" class="text-[11.5px] text-subtle mt-1">{{ size(editing.text.length) }} (max 500k)</p>
        </div>

        <div>
          <span class="label">Who may read it</span>
          <label class="flex items-center gap-2 mb-2"><input v-model="editing.everyone" type="checkbox" class="size-4 accent-[var(--color-brand)]" />Everyone in the company</label>
          <div v-if="!editing.everyone" class="rounded-lg bg-surface-2 p-3 space-y-2 animate-in">
            <div>
              <p class="text-[12px] text-muted mb-1">Departments</p>
              <div class="flex flex-wrap gap-1.5">
                <button v-for="d in departments" :key="d" class="chip h-7" :class="editing.departments.includes(d) ? 'bg-brand-soft text-brand border-brand' : ''" @click="toggle(editing.departments, d)">{{ d }}</button>
                <span v-if="!departments.length" class="text-[12px] text-subtle">No departments set on users yet.</span>
              </div>
            </div>
            <div>
              <p class="text-[12px] text-muted mb-1">Roles (anyone with this role)</p>
              <div class="flex flex-wrap gap-1.5">
                <button v-for="r in ROLE_CHOICES" :key="r" class="chip h-7" :class="editing.roles.includes(r) ? 'bg-brand-soft text-brand border-brand' : ''" @click="toggle(editing.roles, r)">{{ roleLabels[r] }}</button>
              </div>
            </div>
          </div>
        </div>

        <div>
          <span class="label">Which AI staff may use it</span>
          <label class="flex items-center gap-2 mb-2"><input v-model="editing.allAgents" type="checkbox" class="size-4 accent-[var(--color-brand)]" />All AI staff</label>
          <div v-if="!editing.allAgents" class="flex flex-wrap gap-1.5 animate-in">
            <button v-for="a in agents" :key="a.agentId" class="chip h-8 pl-1" :class="editing.agentIds.includes(a.agentId) ? 'bg-brand-soft text-brand border-brand' : ''" @click="toggle(editing.agentIds, a.agentId)">
              <AgentAvatar :avatar="a.avatar" :color="a.color" :size="22" />{{ a.name }}
            </button>
          </div>
          <p class="text-[11.5px] text-subtle mt-1">An AI only uses a document if the person it is helping may also read it.</p>
        </div>
      </div>
      <template #footer>
        <span v-if="formProblem" class="text-[12px] text-muted mr-auto self-center">{{ formProblem }}</span>
        <button class="btn-secondary" @click="editing = null">Cancel</button>
        <button class="btn-primary" :disabled="!!formProblem || saving || extracting" @click="save">
          <Loader2 v-if="saving" class="size-4 animate-spin" />{{ editing.docId ? 'Save' : 'Add document' }}
        </button>
      </template>
    </Modal>
  </div>
</template>
