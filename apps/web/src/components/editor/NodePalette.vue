<script setup lang="ts">
import { computed, ref } from 'vue';
import { Search } from '@lucide/vue';
import type { NodeDescriptor } from '@widebed/shared';
import { useNodeTypesStore } from '@/stores/nodeTypes';
import { categoryLabels } from '@/lib/icons';
import NodeIcon from '@/components/ui/NodeIcon.vue';

const emit = defineEmits<{ add: [NodeDescriptor] }>();
const store = useNodeTypesStore();
const q = ref('');
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
        <input v-model="q" class="input pl-8" placeholder="Search nodes" />
      </div>
    </div>
    <div class="flex-1 overflow-y-auto p-2">
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
