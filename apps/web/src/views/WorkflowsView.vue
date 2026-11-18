<script setup lang="ts">
import Skeleton from '@/components/ui/Skeleton.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Copy, Download, Folder, FolderPlus, Inbox, Layers, LayoutTemplate, MoreHorizontal, Pencil, Plus, Power, Search, Share2, Trash2, Upload, Users as UsersIcon, Workflow as WorkflowIcon } from '@lucide/vue';
import ImportWorkflowModal from '@/components/ImportWorkflowModal.vue';
import ShareWorkflowModal from '@/components/ShareWorkflowModal.vue';
import { downloadJson, fileSlug } from '@/lib/download';
import { TEMPLATE_CATEGORIES, type Workflow, type WorkflowFolder } from '@widebed/shared';
import { api } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';
import { timeAgo } from '@/lib/format';
import { useAuthStore } from '@/stores/auth';
import { useNodeTypesStore } from '@/stores/nodeTypes';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import Modal from '@/components/ui/Modal.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import NodeIcon from '@/components/ui/NodeIcon.vue';

type Row = Omit<Workflow, 'draftDefinition'> & { nodeCount: number; nodeTypes: string[] };

const router = useRouter();
const auth = useAuthStore();
const nodeTypes = useNodeTypesStore();
const workflows = ref<Row[]>([]);
const folders = ref<WorkflowFolder[]>([]);
const loading = ref(true);
const search = ref('');
const folderFilter = ref<string | undefined>(undefined); // undefined = all, 'none' = unfiled
const statusFilter = ref('');
const tagFilter = ref('');
const menuFor = ref<string | null>(null);

const showCreate = ref(false);
const form = ref({ name: '', description: '', department: '', folderId: '', tags: '' });
const showFolder = ref(false);

/* ---------- Save as template ---------- */
const templating = ref<Row | null>(null);
const tpl = ref({ name: '', description: '', category: 'Custom', needs: '' });
function openTemplate(w: Row) {
  templating.value = w;
  tpl.value = { name: w.name, description: w.description, category: 'Custom', needs: '' };
  menuFor.value = null;
}
async function saveTemplate() {
  if (!templating.value) return;
  try {
    await api('/templates', {
      method: 'POST',
      body: {
        workflowId: templating.value.workflowId,
        name: tpl.value.name,
        description: tpl.value.description,
        category: tpl.value.category,
        needs: tpl.value.needs.split('\n').map((x) => x.trim()).filter(Boolean),
      },
    });
    toast('Saved as a template. Find it on the Templates page.', 'success');
    templating.value = null;
  } catch (err) {
    toastError(err);
  }
}
const folderName = ref('');
const moving = ref<Row | null>(null);
const deleting = ref<Row | null>(null);
const showImport = ref(false);
const sharing = ref<Row | null>(null);
function onShared(list: string[]) {
  if (sharing.value) sharing.value.sharedWith = list;
}

async function exportRow(w: Row) {
  menuFor.value = null;
  try {
    downloadJson(await api(`/workflows/${w.workflowId}/export`), `${fileSlug(w.name)}.widebed.json`);
  } catch (err) {
    toastError(err);
  }
}

const canCreate = computed(() => auth.can('workflow.create'));
const isAdmin = computed(() => auth.can('workflow.manageAll'));
const allTags = computed(() => [...new Set(workflows.value.flatMap((w) => w.tags))].sort());

async function load() {
  loading.value = true;
  try {
    const [w, f] = await Promise.all([
      api<{ items: Row[] }>('/workflows', { query: { search: search.value, folderId: folderFilter.value, status: statusFilter.value, tag: tagFilter.value } }),
      api<{ items: WorkflowFolder[] }>('/folders'),
      nodeTypes.load(),
    ]);
    workflows.value = w.items;
    folders.value = f.items;
  } catch (err) {
    toastError(err);
  } finally {
    loading.value = false;
  }
}

let t: number;
watch(search, () => {
  clearTimeout(t);
  t = window.setTimeout(load, 250);
});
watch([folderFilter, statusFilter, tagFilter], load);
onMounted(load);
// The ••• menu closes when you click anywhere else or press Esc (clicks inside it are stopped by @click.stop).
const closeMenu = () => (menuFor.value = null);
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeMenu();
onMounted(() => {
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', closeMenu);
  document.removeEventListener('keydown', onKey);
});

async function create() {
  try {
    const wf = await api<Workflow>('/workflows', {
      method: 'POST',
      body: {
        name: form.value.name,
        description: form.value.description,
        department: form.value.department || null,
        folderId: form.value.folderId || null,
        tags: form.value.tags.split(',').map((s) => s.trim()).filter(Boolean),
      },
    });
    showCreate.value = false;
    router.push(`/workflows/${wf.workflowId}/edit`);
  } catch (err) {
    toastError(err);
  }
}

async function createFolder() {
  try {
    await api('/folders', { method: 'POST', body: { name: folderName.value } });
    showFolder.value = false;
    folderName.value = '';
    load();
  } catch (err) {
    toastError(err);
  }
}

async function duplicate(w: Row) {
  menuFor.value = null;
  try {
    await api(`/workflows/${w.workflowId}/duplicate`, { method: 'POST' });
    toast('Workflow duplicated', 'success');
    load();
  } catch (err) {
    toastError(err);
  }
}

async function toggleActive(w: Row) {
  menuFor.value = null;
  try {
    await api(`/workflows/${w.workflowId}/${w.status === 'active' ? 'deactivate' : 'activate'}`, { method: 'POST' });
    toast(w.status === 'active' ? 'Workflow deactivated' : 'Workflow activated', 'success');
    load();
  } catch (err) {
    toastError(err);
  }
}

async function moveTo(folderId: string | null) {
  if (!moving.value) return;
  try {
    await api(`/workflows/${moving.value.workflowId}`, { method: 'PATCH', body: { folderId } });
    moving.value = null;
    load();
  } catch (err) {
    toastError(err);
  }
}

async function remove() {
  if (!deleting.value) return;
  try {
    await api(`/workflows/${deleting.value.workflowId}`, { method: 'DELETE' });
    toast('Workflow deleted', 'success');
    deleting.value = null;
    load();
  } catch (err) {
    toastError(err);
  }
}

const folderName_ = (id: string | null) => folders.value.find((f) => f.folderId === id)?.name;
const typeInfo = (type: string) => nodeTypes.get(type);
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1280px] mx-auto" @click="menuFor = null">
    <PageHeader title="Workflows" subtitle="Create, organise and publish automations.">
      <div v-if="canCreate" class="flex flex-wrap gap-2">
        <button class="btn-secondary" @click="showFolder = true"><FolderPlus class="size-4" />New folder</button>
        <button class="btn-secondary" @click="showImport = true"><Upload class="size-4" />Import</button>
        <button class="btn-primary" @click="(form = { name: '', description: '', department: '', folderId: folderFilter && folderFilter !== 'none' ? folderFilter : '', tags: '' }), (showCreate = true)">
          <Plus class="size-4" />New workflow
        </button>
      </div>
    </PageHeader>

    <div class="grid lg:grid-cols-[200px_minmax(0,1fr)] gap-6">
      <!-- Folders -->
      <nav class="space-y-0.5">
        <button
          v-for="f in [{ id: undefined, name: 'All workflows', icon: Layers }, { id: 'none', name: 'Unfiled', icon: Inbox }]"
          :key="String(f.id)"
          class="w-full flex items-center gap-2 h-8 px-2.5 rounded-md text-[13px]"
          :class="folderFilter === f.id ? 'bg-surface text-ink font-medium border border-line' : 'text-muted hover:text-ink'"
          @click="folderFilter = f.id"
        >
          <component :is="f.icon" class="size-4" />{{ f.name }}
        </button>
        <div class="pt-3 pb-1 px-2.5 text-[11px] uppercase tracking-wide font-semibold text-subtle">Folders</div>
        <button
          v-for="f in folders"
          :key="f.folderId"
          class="w-full flex items-center gap-2 h-8 px-2.5 rounded-md text-[13px]"
          :class="folderFilter === f.folderId ? 'bg-surface text-ink font-medium border border-line' : 'text-muted hover:text-ink'"
          @click="folderFilter = f.folderId"
        >
          <Folder class="size-4" /><span class="truncate">{{ f.name }}</span>
        </button>
        <p v-if="!folders.length" class="px-2.5 text-[12px] text-subtle">No folders yet</p>
      </nav>

      <div class="min-w-0">
        <div class="flex flex-wrap gap-2 mb-3">
          <div class="relative flex-1 min-w-[220px]">
            <Search class="size-4 text-subtle absolute left-2.5 top-2" />
            <input v-model="search" class="input pl-8" placeholder="Search name, description or tag" />
          </div>
          <select v-model="statusFilter" class="input w-auto">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <select v-if="allTags.length" v-model="tagFilter" class="input w-auto">
            <option value="">All tags</option>
            <option v-for="tg in allTags" :key="tg" :value="tg">{{ tg }}</option>
          </select>
        </div>

        <div class="card">
          <Skeleton v-if="loading && !workflows.length" kind="list" :rows="6" />
          <EmptyState v-else-if="!workflows.length" :icon="WorkflowIcon" title="No workflows here" :text="canCreate ? 'Create your first workflow to start automating.' : 'Workflows shared with you will appear here.'">
            <button v-if="canCreate" class="btn-primary" @click="showCreate = true"><Plus class="size-4" />New workflow</button>
          </EmptyState>
          <ul v-else>
            <li
              v-for="(w, idx) in workflows"
              :key="w.workflowId"
              :style="{ '--i': idx }"
              class="animate-in flex items-center gap-4 px-4 py-3 border-b border-line last:border-0 hover:bg-surface-2 transition-colors cursor-pointer"
              :class="menuFor === w.workflowId ? 'relative z-30' : ''"
              @click="router.push(`/workflows/${w.workflowId}/edit`)"
            >
              <div class="flex -space-x-1.5 w-[76px] shrink-0">
                <template v-for="nt in w.nodeTypes.slice(0, 3)" :key="nt">
                  <NodeIcon v-if="typeInfo(nt)" :icon="typeInfo(nt)!.icon" :category="typeInfo(nt)!.category" size="sm" class="ring-2 ring-surface" />
                </template>
                <span v-if="!w.nodeTypes.length" class="text-[12px] text-subtle">empty</span>
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="font-medium truncate min-w-0">{{ w.name }}</span>
                  <span v-for="tg in w.tags.slice(0, 3)" :key="tg" class="chip shrink-0">{{ tg }}</span>
                  <span v-if="w.sharedWith.includes(auth.profile?.uid ?? '')" class="chip shrink-0">shared with you</span>
                  <span v-else-if="w.sharedWith.length" class="chip shrink-0 inline-flex items-center gap-1" :title="`Shared with ${w.sharedWith.length} ${w.sharedWith.length === 1 ? 'person' : 'people'}`"><UsersIcon class="size-3" />{{ w.sharedWith.length }}</span>
                </div>
                <div class="text-[12px] text-subtle truncate mt-0.5">
                  {{ w.description || 'No description' }}
                  <template v-if="w.department"> · {{ w.department }}</template>
                  <template v-if="w.folderId && folderName_(w.folderId)"> · {{ folderName_(w.folderId) }}</template>
                </div>
              </div>
              <div class="hidden md:block text-[12px] text-muted w-[80px] shrink-0">{{ w.publishedVersion ? `v${w.publishedVersion}` : 'Draft only' }}</div>
              <StatusBadge :status="w.status" class="shrink-0" />
              <div class="hidden lg:block text-[12px] text-subtle w-[64px] text-right shrink-0">{{ timeAgo(w.updatedAt) }}</div>
              <div class="relative shrink-0" @click.stop>
                <button class="btn-ghost btn-icon" aria-label="Actions" @click="menuFor = menuFor === w.workflowId ? null : w.workflowId"><MoreHorizontal class="size-4" /></button>
                <div v-if="menuFor === w.workflowId" class="animate-menu absolute right-0 top-9 z-20 card shadow-[var(--shadow-pop)] w-48 py-1 text-[13px]">
                  <button class="w-full flex items-center gap-2 px-3 h-8 hover:bg-surface-2" @click="router.push(`/workflows/${w.workflowId}/edit`)"><Pencil class="size-4 text-muted" />Open editor</button>
                  <button v-if="canCreate && (w.ownerId === auth.profile?.uid || isAdmin || auth.can('workflow.manageDepartment'))" class="w-full flex items-center gap-2 px-3 h-8 hover:bg-surface-2" @click="(sharing = w), (menuFor = null)"><Share2 class="size-4 text-muted" />Share…</button>
                  <button v-if="canCreate" class="w-full flex items-center gap-2 px-3 h-8 hover:bg-surface-2" @click="duplicate(w)"><Copy class="size-4 text-muted" />Duplicate</button>
                  <button class="w-full flex items-center gap-2 px-3 h-8 hover:bg-surface-2" @click="exportRow(w)"><Download class="size-4 text-muted" />Export (.json)</button>
                  <button v-if="canCreate" class="w-full flex items-center gap-2 px-3 h-8 hover:bg-surface-2" @click="openTemplate(w)"><LayoutTemplate class="size-4 text-muted" />Save as template</button>
                  <button class="w-full flex items-center gap-2 px-3 h-8 hover:bg-surface-2 disabled:opacity-50" :disabled="!w.publishedVersion" @click="toggleActive(w)">
                    <Power class="size-4 text-muted" />{{ w.status === 'active' ? 'Deactivate' : 'Activate' }}
                  </button>
                  <button class="w-full flex items-center gap-2 px-3 h-8 hover:bg-surface-2" @click="(moving = w), (menuFor = null)"><Folder class="size-4 text-muted" />Move to folder</button>
                  <div class="border-t border-line my-1" />
                  <button class="w-full flex items-center gap-2 px-3 h-8 hover:bg-bad-soft text-bad" @click="(deleting = w), (menuFor = null)"><Trash2 class="size-4" />Delete</button>
                </div>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <ShareWorkflowModal v-if="sharing" :workflow="sharing" @close="sharing = null" @saved="onShared" />

    <Modal v-if="templating" title="Save as template" width="520px" @close="templating = null">
      <form id="tpl-form" class="space-y-4" @submit.prevent="saveTemplate">
        <p class="text-[12px] text-muted -mt-1">Your team can then create their own copy from the Templates page. Connections (Google, Firebase…) are not saved — everyone picks their own.</p>
        <div><label class="label">Template name</label><input v-model="tpl.name" class="input" required maxlength="120" /></div>
        <div><label class="label">What does it do?</label><textarea v-model="tpl.description" class="textarea" rows="2" maxlength="500" placeholder="e.g. Every Monday, emails the cleaning schedule to the team." /></div>
        <div>
          <label class="label">Category</label>
          <select v-model="tpl.category" class="input"><option v-for="c in TEMPLATE_CATEGORIES" :key="c" :value="c">{{ c }}</option></select>
        </div>
        <div><label class="label">What do people need first? (one per line, optional)</label><textarea v-model="tpl.needs" class="textarea" rows="3" placeholder="A Google Sheet with the columns Name, Email, Room" /></div>
      </form>
      <template #footer>
        <button class="btn-secondary" @click="templating = null">Cancel</button>
        <button class="btn-primary" form="tpl-form" type="submit"><LayoutTemplate class="size-4" />Save template</button>
      </template>
    </Modal>

    <Modal v-if="showCreate" title="New workflow" @close="showCreate = false">
      <form id="create-wf" class="space-y-4" @submit.prevent="create">
        <RouterLink to="/templates" class="flex items-center gap-2.5 rounded-md border border-dashed border-line-strong p-3 text-[13px] hover:border-brand hover:bg-brand-soft transition-colors">
          <LayoutTemplate class="size-4 text-brand shrink-0" />
          <span><b>New here?</b> Start from a ready-made template instead (rent reminders, booking alerts…)</span>
        </RouterLink>
        <div><label class="label">Name</label><input v-model="form.name" class="input" required maxlength="120" placeholder="e.g. Check-in reminder" /></div>
        <div><label class="label">Description</label><textarea v-model="form.description" class="textarea" rows="2" maxlength="2000" /></div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="label">Folder</label>
            <select v-model="form.folderId" class="input">
              <option value="">No folder</option>
              <option v-for="f in folders" :key="f.folderId" :value="f.folderId">{{ f.name }}</option>
            </select>
          </div>
          <div>
            <label class="label">Department</label>
            <input v-if="isAdmin" v-model="form.department" class="input" placeholder="e.g. Operations" />
            <input v-else class="input" disabled :value="auth.profile?.department ?? '—'" />
          </div>
        </div>
        <div><label class="label">Tags (comma separated)</label><input v-model="form.tags" class="input" placeholder="pms, tenants" /></div>
      </form>
      <template #footer>
        <button class="btn-secondary" @click="showCreate = false">Cancel</button>
        <button class="btn-primary" form="create-wf" type="submit">Create and open editor</button>
      </template>
    </Modal>

    <ImportWorkflowModal v-if="showImport" :folder-id="folderFilter && folderFilter !== 'none' ? folderFilter : null" @close="showImport = false" @imported="load" />

    <Modal v-if="showFolder" title="New folder" @close="showFolder = false">
      <form id="create-folder" @submit.prevent="createFolder"><label class="label">Folder name</label><input v-model="folderName" class="input" required maxlength="80" /></form>
      <template #footer>
        <button class="btn-secondary" @click="showFolder = false">Cancel</button>
        <button class="btn-primary" form="create-folder" type="submit">Create folder</button>
      </template>
    </Modal>

    <Modal v-if="moving" :title="`Move “${moving.name}”`" @close="moving = null">
      <div class="space-y-1">
        <button class="w-full text-left px-3 h-9 rounded-md hover:bg-surface-2 flex items-center gap-2" @click="moveTo(null)"><Inbox class="size-4 text-muted" />No folder</button>
        <button v-for="f in folders" :key="f.folderId" class="w-full text-left px-3 h-9 rounded-md hover:bg-surface-2 flex items-center gap-2" @click="moveTo(f.folderId)">
          <Folder class="size-4 text-muted" />{{ f.name }}
        </button>
      </div>
    </Modal>

    <Modal v-if="deleting" title="Delete workflow" @close="deleting = null">
      <p class="text-[13px]">Delete <b>{{ deleting.name }}</b>? Its versions and webhook URLs are removed. Past execution history is kept until it expires.</p>
      <template #footer>
        <button class="btn-secondary" @click="deleting = null">Cancel</button>
        <button class="btn-danger" @click="remove"><Trash2 class="size-4" />Delete</button>
      </template>
    </Modal>
  </div>
</template>
