<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Search, Trash2, Users } from '@lucide/vue';
import type { NodeDescriptor } from '@widebed/shared';
import { useNodeTypesStore } from '@/stores/nodeTypes';
import { categoryLabels } from '@/lib/icons';
import NodeIcon from '@/components/ui/NodeIcon.vue';
import { useCustomStepsStore, type TeamStep } from '@/stores/customSteps';
import { toast } from '@/lib/toast';

const emit = defineEmits<{ add: [NodeDescriptor]; addStep: [TeamStep] }>();
const store = useNodeTypesStore();
const teamSteps = useCustomStepsStore();
onMounted(() => teamSteps.load().catch(() => undefined));
const myTeamSteps = computed(() => {
  const s = q.value.trim().toLowerCase();
  return teamSteps.items.filter((t) => !s || t.name.toLowerCase().includes(s) || t.description.toLowerCase().includes(s));
});
const categoryOf = (t: TeamStep) => store.get(t.baseType)?.category ?? 'data';
function onStepDragStart(e: DragEvent, t: TeamStep) {
  e.dataTransfer?.setData('application/wb-step', t.stepId);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
async function removeStep(t: TeamStep) {
  if (!window.confirm(`Delete the team step “${t.name}”? Workflows that use it will stop at that step until it is replaced.`)) return;
  try {
    await teamSteps.remove(t.stepId);
    toast('Team step deleted', 'success');
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}
const q = ref('');
const searchEl = ref<HTMLInputElement | null>(null);
/** Used by the canvas toolbar's "Add node" button. */
function focusSearch() {
  searchEl.value?.focus();
  searchEl.value?.select();
}
defineExpose({ focusSearch });
const order = ['trigger', 'logic', 'data', 'communication', 'ai'];

const groups = computed(() => {
  const s = q.value.trim().toLowerCase();
  const match = (name: string) => !s || name.toLowerCase().includes(s);
  return order
    .map((cat) => ({
      cat,
      nodes: store.nodes.filter((n) => n.available && n.category === cat && match(n.displayName)),
      planned: store.planned.filter((p) => p.category === cat && match(p.displayName)),
    }))
    .filter((g) => g.nodes.length || g.planned.length);
});

function onDragStart(e: DragEvent, n: NodeDescriptor) {
  e.dataTransfer?.setData('application/wb-node', n.type);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
</script>

<template>
  <aside class="w-[248px] shrink-0 border-r border-line bg-surface flex flex-col min-h-0">
    <div class="p-3 border-b border-line">
      <div class="relative">
        <Search class="size-4 text-subtle absolute left-2.5 top-2" />
        <input ref="searchEl" v-model="q" class="input pl-8" placeholder="Search nodes" />
      </div>
    </div>
    <div class="flex-1 overflow-y-auto p-2">
      <section v-if="myTeamSteps.length" class="mb-3">
        <h3 class="px-2 py-1.5 text-[11px] uppercase tracking-wide font-semibold text-subtle flex items-center gap-1"><Users class="size-3" />My team's steps</h3>
        <div v-for="t in myTeamSteps" :key="t.stepId" class="group relative">
          <button
            draggable="true"
            data-no-loading
            class="w-full flex items-center gap-2.5 p-2 pr-7 rounded-md text-left hover:bg-surface-2 hover:translate-x-0.5 transition-[background-color,transform] duration-150 cursor-grab active:cursor-grabbing active:scale-[0.98]"
            :title="`${t.description || t.name}${t.createdByName ? ` — saved by ${t.createdByName}` : ''}${t.department ? '' : ' (shared with everyone)'}`"
            @dragstart="onStepDragStart($event, t)"
            @click="emit('addStep', t)"
          >
            <NodeIcon :icon="t.icon" :category="categoryOf(t)" size="sm" />
            <span class="min-w-0">
              <span class="block text-[13px] font-medium truncate">{{ t.name }}</span>
              <span class="block text-[11px] text-subtle truncate">{{ t.description || store.get(t.baseType)?.displayName }}</span>
            </span>
          </button>
          <button v-if="t.canManage" class="absolute right-1 top-1/2 -translate-y-1/2 btn-ghost btn-icon size-6 opacity-0 group-hover:opacity-100 focus:opacity-100" :aria-label="`Delete team step ${t.name}`" title="Delete this team step" @click.stop="removeStep(t)"><Trash2 class="size-3.5" /></button>
        </div>
      </section>
      <section v-for="g in groups" :key="g.cat" class="mb-3">
        <h3 class="px-2 py-1.5 text-[11px] uppercase tracking-wide font-semibold text-subtle">{{ categoryLabels[g.cat] }}</h3>
        <button
          v-for="n in g.nodes"
          :key="n.type"
          draggable="true"
          data-no-loading
          class="w-full flex items-center gap-2.5 p-2 rounded-md text-left hover:bg-surface-2 hover:translate-x-0.5 transition-[background-color,transform] duration-150 cursor-grab active:cursor-grabbing active:scale-[0.98]"
          :title="n.description"
          @dragstart="onDragStart($event, n)"
          @click="emit('add', n)"
        >
          <NodeIcon :icon="n.icon" :category="n.category" size="sm" />
          <span class="min-w-0">
            <span class="block text-[13px] font-medium truncate">{{ n.displayName }}</span>
            <span class="block text-[11px] text-subtle truncate">{{ n.description }}</span>
          </span>
        </button>
        <div v-for="p in g.planned" :key="p.type" class="flex items-center gap-2.5 p-2 opacity-50 cursor-not-allowed" :title="`Available in Phase ${p.phase}`">
          <NodeIcon :icon="p.icon" :category="p.category" size="sm" />
          <span class="text-[13px] flex-1 truncate">{{ p.displayName }}</span>
          <span class="text-[10px] text-subtle shrink-0">Phase {{ p.phase }}</span>
        </div>
      </section>
    </div>
    <p class="p-3 border-t border-line text-[11px] text-subtle">Drag a node onto the canvas, or click to add it.</p>
  </aside>
</template>
