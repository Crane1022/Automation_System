<script setup lang="ts">
import Skeleton from '@/components/ui/Skeleton.vue';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowRight, Check, ClipboardList, LayoutTemplate, Search, Sparkles, Trash2 } from '@lucide/vue';
import { TEMPLATE_CATEGORIES, type WorkflowTemplate } from '@widebed/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import Modal from '@/components/ui/Modal.vue';
import NodeIcon from '@/components/ui/NodeIcon.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { api } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';
import { useAuthStore } from '@/stores/auth';
import { useNodeTypesStore } from '@/stores/nodeTypes';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const nodeTypes = useNodeTypesStore();

const builtIn = ref<WorkflowTemplate[]>([]);
const saved = ref<WorkflowTemplate[]>([]);
const loading = ref(true);
const search = ref('');
const category = ref<string>(typeof route.query.category === 'string' ? route.query.category : 'All');
const canCreate = computed(() => auth.can('workflow.create'));

async function load() {
  loading.value = true;
  try {
    const res = await api<{ builtIn: WorkflowTemplate[]; saved: WorkflowTemplate[] }>('/templates');
    builtIn.value = res.builtIn;
    saved.value = res.saved;
  } catch (err) {
    toastError(err);
  } finally {
    loading.value = false;
  }
}
onMounted(() => Promise.all([load(), nodeTypes.load()]));

const all = computed(() => [...builtIn.value, ...saved.value]);
const categories = computed(() => ['All', ...TEMPLATE_CATEGORIES.filter((c) => all.value.some((t) => t.category === c))]);
const shown = computed(() => {
  const q = search.value.trim().toLowerCase();
  return all.value.filter(
    (t) => (category.value === 'All' || t.category === category.value) && (!q || `${t.name} ${t.description} ${t.category}`.toLowerCase().includes(q)),
  );
});

/** The steps of a template in order (trigger first), for the preview. */
function stepsOf(t: WorkflowTemplate) {
  const nodes = t.definition.nodes;
  const ordered: typeof nodes = [];
  const start = nodes.find((n) => nodeTypes.get(n.type)?.isTrigger) ?? nodes[0];
  const seen = new Set<string>();
  const queue = start ? [start] : [];
  while (queue.length) {
    const n = queue.shift()!;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    ordered.push(n);
    for (const c of t.definition.connections.filter((c) => c.source === n.id)) {
      const next = nodes.find((x) => x.id === c.target);
      if (next) queue.push(next);
    }
  }
  return [...ordered, ...nodes.filter((n) => !seen.has(n.id))].map((n) => ({ node: n, desc: nodeTypes.get(n.type) }));
}

/* ---------- Use a template ---------- */
const open = ref<WorkflowTemplate | null>(null);
const newName = ref('');
const busy = ref(false);
function preview(t: WorkflowTemplate) {
  open.value = t;
  newName.value = t.name;
}
async function useTemplate() {
  const t = open.value;
  if (!t) return;
  busy.value = true;
  try {
    const file = { format: 'widebed-automation/workflow', formatVersion: 1, exportedAt: new Date().toISOString(), workflow: { name: t.name, description: t.description, tags: ['template'], definition: t.definition }, credentials: [] };
    const res = await api<{ workflow: { workflowId: string }; report: { needsCredential: string[] } }>('/workflows/import', { method: 'POST', body: { file, name: newName.value.trim() || t.name, autoConnect: true } });
    const missing = res.report.needsCredential.length;
    toast(missing ? `Created! Now fill in the steps marked with a warning (${missing} need a connection).` : 'Created! Fill in the steps marked with a warning, then Test run.', 'success', 7000);
    router.push(`/workflows/${res.workflow.workflowId}/edit`);
  } catch (err) {
    toastError(err);
  } finally {
    busy.value = false;
  }
}

const canDelete = (t: WorkflowTemplate) => !t.builtIn && (t.createdBy === auth.profile?.uid || auth.can('workflow.manageAll'));
async function remove(t: WorkflowTemplate) {
  if (!confirm(`Delete the template “${t.name}”? Workflows already made from it are not affected.`)) return;
  try {
    await api(`/templates/${t.templateId}`, { method: 'DELETE' });
    open.value = null;
    toast('Template deleted', 'success');
    load();
  } catch (err) {
    toastError(err);
  }
}
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1280px] mx-auto">
    <PageHeader title="Templates" subtitle="Start from a ready-made workflow, then adjust it to your needs. Nothing runs until you publish it." />

    <div class="flex flex-wrap items-center gap-2 mb-5">
      <div class="relative flex-1 min-w-[220px] max-w-[360px]">
        <Search class="size-4 text-subtle absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input v-model="search" class="input pl-8" placeholder="Search templates, e.g. “rent” or “booking”" />
      </div>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="c in categories"
          :key="c"
          class="h-8 px-3 rounded-full border text-[12px] font-medium transition-colors"
          :class="category === c ? 'bg-brand text-white border-brand' : 'bg-surface border-line text-muted hover:text-ink'"
          @click="category = c"
        >
          {{ c }}
        </button>
      </div>
    </div>

    <Skeleton v-if="loading" kind="cards" :rows="6" />
    <div v-else-if="!shown.length" class="card"><EmptyState :icon="LayoutTemplate" title="No templates match" text="Try another word or category." /></div>
    <div v-else class="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
      <button
        v-for="(t, idx) in shown"
        :key="t.templateId"
        :style="{ '--i': idx }"
        class="animate-in card card-hover p-4 text-left flex flex-col gap-3 hover:border-brand group"
        data-no-loading
        @click="preview(t)"
      >
        <div class="flex items-center gap-1">
          <template v-for="(s, i) in stepsOf(t)" :key="s.node.id">
            <NodeIcon :icon="s.desc?.icon ?? 'box'" :category="s.desc?.category ?? 'data'" size="sm" />
            <ArrowRight v-if="i < stepsOf(t).length - 1" class="size-3 text-subtle" />
          </template>
        </div>
        <div class="flex-1">
          <div class="font-semibold text-[14px] group-hover:text-brand">{{ t.name }}</div>
          <p class="text-[13px] text-muted mt-1 leading-relaxed">{{ t.description }}</p>
        </div>
        <div class="flex items-center gap-2 text-[11px]">
          <span class="chip">{{ t.category }}</span>
          <span class="text-subtle">{{ t.builtIn ? 'Built-in' : `Saved by ${t.createdByName ?? 'a colleague'}` }}</span>
        </div>
      </button>
    </div>

    <div class="card p-4 mt-6 flex gap-3 items-start text-[13px]">
      <Sparkles class="size-4 text-brand shrink-0 mt-0.5" />
      <p class="text-muted">
        <b class="text-ink">Make your own:</b> build a workflow, then on the Workflows page click <b>⋯ → Save as template</b>. Your team will see it here.
        Connections are never saved in a template.
      </p>
    </div>

    <Modal v-if="open" :title="open.name" width="640px" @close="open = null">
      <p class="text-[13px] text-muted -mt-1">{{ open.description }}</p>

      <h3 class="section-title mt-5 mb-2">How it works</h3>
      <ol class="space-y-2">
        <li v-for="(s, i) in stepsOf(open)" :key="s.node.id" class="flex items-center gap-2.5 text-[13px]">
          <span class="size-5 rounded-full bg-surface-2 border border-line text-[11px] grid place-items-center shrink-0 text-muted">{{ i + 1 }}</span>
          <NodeIcon :icon="s.desc?.icon ?? 'box'" :category="s.desc?.category ?? 'data'" size="sm" />
          <span class="font-medium">{{ s.node.name }}</span>
          <span class="text-subtle truncate">· {{ s.desc?.displayName ?? s.node.type }}</span>
        </li>
      </ol>

      <template v-if="open.needs.length">
        <h3 class="section-title mt-5 mb-2">Before you start</h3>
        <ul class="space-y-1.5">
          <li v-for="(x, i) in open.needs" :key="i" class="flex gap-2 text-[13px]"><ClipboardList class="size-4 shrink-0 mt-0.5 text-subtle" />{{ x }}</li>
        </ul>
      </template>

      <h3 class="section-title mt-5 mb-2">After you create it</h3>
      <ol class="space-y-1.5">
        <li v-for="(x, i) in open.setup" :key="i" class="flex gap-2 text-[13px]"><Check class="size-4 shrink-0 mt-0.5 text-brand" />{{ x }}</li>
      </ol>

      <div v-if="canCreate" class="mt-5">
        <label class="label">Name of your new workflow</label>
        <input v-model="newName" class="input" maxlength="120" @keydown.enter="useTemplate" />
      </div>
      <p v-else class="mt-5 text-[12px] text-subtle">Ask a Department Manager or IT Admin to create workflows from templates.</p>

      <template #footer>
        <button v-if="canDelete(open)" class="btn-ghost text-bad mr-auto" @click="remove(open)"><Trash2 class="size-4" />Delete template</button>
        <button class="btn-secondary" @click="open = null">Close</button>
        <button v-if="canCreate" class="btn-primary" :disabled="busy" @click="useTemplate"><LayoutTemplate class="size-4" />Use this template</button>
      </template>
    </Modal>
  </div>
</template>
