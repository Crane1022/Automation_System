<script setup lang="ts">
import { computed } from 'vue';
import { ArrowRight, Minus, Pencil, Plus, Link2, Unlink } from '@lucide/vue';
import { diffDefinitions, type WorkflowDefinition } from '@widebed/shared';
import { useNodeTypesStore } from '@/stores/nodeTypes';

/** Shows what changed from `before` to `after` in plain words. */
const props = defineProps<{
  before: Pick<WorkflowDefinition, 'nodes' | 'connections'>;
  after: Pick<WorkflowDefinition, 'nodes' | 'connections'>;
  beforeLabel: string;
  afterLabel: string;
}>();

const types = useNodeTypesStore();
const d = computed(() => diffDefinitions(props.before, props.after));
const typeName = (t: string) => types.get(t)?.displayName ?? t;

/** Field names from node settings → the label shown in the settings panel, when we know it. */
function fieldLabel(type: string, field: string) {
  return types.get(type)?.fields?.find((f) => f.key === field)?.label ?? field;
}
function show(v: unknown, field: string) {
  if (field === 'Connection') return v ? 'a connection' : 'none';
  if (v === null || v === undefined || v === '') return 'empty';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}
</script>

<template>
  <div class="text-[13px]">
    <div class="flex items-center gap-2 text-[12px] text-muted mb-3">
      <span class="chip">{{ beforeLabel }}</span><ArrowRight class="size-3.5" /><span class="chip">{{ afterLabel }}</span>
    </div>

    <p v-if="d.same" class="text-muted">
      No differences that change how it runs.<template v-if="d.moved"> ({{ d.moved }} {{ d.moved === 1 ? 'step was' : 'steps were' }} only moved on the canvas.)</template>
    </p>

    <ul v-else class="space-y-2">
      <li v-for="n in d.added" :key="`a-${n.id}`" class="flex gap-2.5 items-start">
        <span class="size-5 rounded bg-ok-soft text-ok grid place-items-center shrink-0 mt-0.5"><Plus class="size-3" /></span>
        <span>Added <b class="font-medium">{{ n.name }}</b> <span class="text-subtle">· {{ typeName(n.type) }}</span></span>
      </li>
      <li v-for="n in d.removed" :key="`r-${n.id}`" class="flex gap-2.5 items-start">
        <span class="size-5 rounded bg-bad-soft text-bad grid place-items-center shrink-0 mt-0.5"><Minus class="size-3" /></span>
        <span>Removed <b class="font-medium">{{ n.name }}</b> <span class="text-subtle">· {{ typeName(n.type) }}</span></span>
      </li>
      <li v-for="n in d.changed" :key="`c-${n.id}`" class="flex gap-2.5 items-start">
        <span class="size-5 rounded bg-brand-soft text-brand grid place-items-center shrink-0 mt-0.5"><Pencil class="size-3" /></span>
        <div class="min-w-0 flex-1">
          Changed <b class="font-medium">{{ n.name }}</b> <span class="text-subtle">· {{ typeName(n.type) }}</span>
          <ul class="mt-1 space-y-1">
            <li v-for="c in n.changes" :key="c.field" class="text-[12px] rounded-md bg-surface-2 px-2.5 py-1.5">
              <div class="text-muted font-medium mb-0.5">{{ fieldLabel(n.type, c.field) }}</div>
              <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
                <span class="text-subtle">was</span><code class="break-words line-through decoration-bad/50">{{ show(c.before, c.field) }}</code>
                <span class="text-subtle">now</span><code class="break-words">{{ show(c.after, c.field) }}</code>
              </div>
            </li>
          </ul>
        </div>
      </li>
      <li v-for="l in d.links.added" :key="`la-${l}`" class="flex gap-2.5 items-start">
        <span class="size-5 rounded bg-ok-soft text-ok grid place-items-center shrink-0 mt-0.5"><Link2 class="size-3" /></span>
        <span>New link: {{ l }}</span>
      </li>
      <li v-for="l in d.links.removed" :key="`lr-${l}`" class="flex gap-2.5 items-start">
        <span class="size-5 rounded bg-bad-soft text-bad grid place-items-center shrink-0 mt-0.5"><Unlink class="size-3" /></span>
        <span>Link removed: {{ l }}</span>
      </li>
      <li v-if="d.moved" class="text-[12px] text-subtle pl-7">{{ d.moved }} other {{ d.moved === 1 ? 'step was' : 'steps were' }} only moved on the canvas.</li>
    </ul>
  </div>
</template>
