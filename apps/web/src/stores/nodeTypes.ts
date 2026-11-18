import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { NodeCategory, NodeDescriptor } from '@widebed/shared';
import { api } from '@/lib/api';

export interface PlannedNode {
  type: string;
  displayName: string;
  category: NodeCategory;
  icon: string;
  phase: number;
}

/** Node catalog loaded from the backend registry (single source of truth). */
export const useNodeTypesStore = defineStore('nodeTypes', () => {
  const nodes = ref<NodeDescriptor[]>([]);
  const planned = ref<PlannedNode[]>([]);
  const loaded = ref(false);

  async function load() {
    if (loaded.value) return;
    const res = await api<{ nodes: NodeDescriptor[]; planned: PlannedNode[] }>('/node-types');
    nodes.value = res.nodes;
    planned.value = res.planned;
    loaded.value = true;
  }

  const get = (type: string) => nodes.value.find((n) => n.type === type);
  return { nodes, planned, loaded, load, get };
});
