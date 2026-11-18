<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { AlertTriangle, CalendarClock, Copy, FlaskConical, RefreshCw, Trash2, X } from '@lucide/vue';
import type { ExecutionStep, FieldDescriptor } from '@widebed/shared';
import { useNodeTypesStore } from '@/stores/nodeTypes';
import { useCredentialsStore } from '@/stores/credentials';
import { useAuthStore } from '@/stores/auth';
import { PROVIDER_LABELS, TIMEZONE_OPTIONS, describeSchedule, oncePassed, type CredentialProvider, type ScheduleSettings } from '@widebed/shared';
import FieldInput from '@/components/fields/FieldInput.vue';
import NodeIcon from '@/components/ui/NodeIcon.vue';
import JsonView from '@/components/ui/JsonView.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { formatDuration } from '@/lib/format';
import type { WbNodeData } from './types';

const props = defineProps<{
  nodeId: string;
  data: WbNodeData;
  step?: ExecutionStep;
  readonly?: boolean;
  published: boolean;
  busy?: boolean;
}>();
const emit = defineEmits<{
  update: [Partial<WbNodeData>];
  close: [];
  delete: [];
  duplicate: [];
  test: [];
  rotateWebhook: [];
}>();

const store = useNodeTypesStore();
const desc = computed(() => store.get(props.data.nodeType));
const creds = useCredentialsStore();
const auth = useAuthStore();
const provider = computed(() => desc.value?.credentialProvider as CredentialProvider | undefined);
const options = computed(() => (provider.value ? creds.byProvider(provider.value) : []));
watch(provider, (p) => p && creds.load().catch(() => undefined), { immediate: true });
const codeLocked = computed(() => props.data.nodeType === 'data.code' && !auth.can('node.createCustom'));
const tab = ref<'params' | 'output' | 'docs'>('params');
watch(() => props.nodeId, () => (tab.value = props.step ? 'output' : 'params'));
watch(() => props.step?.stepId, (id) => id && (tab.value = 'output'));

const visibleFields = computed(() =>
  (desc.value?.fields ?? []).filter((f: FieldDescriptor) => !f.showIf || f.showIf.equals.includes(props.data.config[f.showIf.key] ?? fieldDefault(f.showIf.key))),
);
function fieldDefault(key: string) {
  return desc.value?.fields.find((f) => f.key === key)?.default;
}
function setField(key: string, v: unknown) {
  emit('update', { config: { ...props.data.config, [key]: v } });
}
const retryEnabled = computed(() => !!props.data.retry);

/** Schedule Trigger: "Every Monday at 9:00 AM" + a warning when a one-time date has passed. */
const schedule = computed(() => {
  if (props.data.nodeType !== 'trigger.schedule') return null;
  const defaults = Object.fromEntries((desc.value?.fields ?? []).map((f) => [f.key, f.default]));
  const s = { ...defaults, ...props.data.config } as unknown as ScheduleSettings;
  const tz = s.timezone || 'Asia/Kuala_Lumpur';
  return {
    text: describeSchedule(s),
    zone: s.mode === 'interval' ? 'Counts from when the workflow is switched to Active.' : `${TIMEZONE_OPTIONS.find((o) => o.value === tz)?.label ?? tz} time`,
    passed: oncePassed(s),
  };
});

/** Tiny markdown renderer for node docs: headings, bold, code, lists. Escapes HTML first. */
const docsHtml = computed(() => {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code class="font-mono text-[12px] bg-surface-2 px-1 rounded">$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>');
  return (desc.value?.docs ?? '')
    .split('\n')
    .map((l) => (l.startsWith('### ') ? `<h4 class="font-semibold text-[13px] mt-1 mb-1.5">${inline(l.slice(4))}</h4>` : l.trim().startsWith('- ') ? `<li class="ml-4 list-disc">${inline(l.trim().slice(2))}</li>` : l.trim() ? `<p class="mb-1.5">${inline(l)}</p>` : ''))
    .join('');
});
</script>

<template>
  <aside class="panel-slide w-[360px] shrink-0 border-l border-line bg-surface flex flex-col min-h-0">
    <header class="p-3 border-b border-line">
      <div class="flex items-start gap-2.5">
        <NodeIcon v-if="desc" :icon="desc.icon" :category="desc.category" size="lg" />
        <div class="min-w-0 flex-1">
          <input
            :value="data.name"
            class="w-full bg-transparent text-[14px] font-semibold outline-none border-b border-transparent focus:border-brand"
            :readonly="readonly"
            maxlength="100"
            aria-label="Node name"
            @change="emit('update', { name: ($event.target as HTMLInputElement).value.trim() || data.name })"
          />
          <p class="text-[12px] text-subtle truncate">{{ desc?.displayName }} · v{{ desc?.version }}</p>
        </div>
        <button class="btn-ghost btn-icon" aria-label="Close panel" @click="emit('close')"><X class="size-4" /></button>
      </div>
      <div v-if="!readonly" class="flex gap-1.5 mt-3">
        <button class="btn-secondary h-7 text-[12px]" :disabled="busy" title="Run from the trigger up to this node" @click="emit('test')"><FlaskConical class="size-3.5" />Test node</button>
        <button class="btn-ghost h-7 text-[12px]" @click="emit('duplicate')"><Copy class="size-3.5" />Duplicate</button>
        <button class="btn-ghost h-7 text-[12px] text-bad hover:bg-bad-soft ml-auto" @click="emit('delete')"><Trash2 class="size-3.5" />Delete</button>
      </div>
    </header>

    <div class="flex border-b border-line px-3 gap-4 text-[13px]">
      <button v-for="t in (['params', 'output', 'docs'] as const)" :key="t" class="h-9 border-b-2 -mb-px" :class="tab === t ? 'border-brand text-ink font-medium' : 'border-transparent text-muted hover:text-ink'" @click="tab = t">
        {{ t === 'params' ? 'Parameters' : t === 'output' ? 'Last run' : 'Docs' }}
      </button>
    </div>

    <div class="flex-1 overflow-y-auto p-3">
      <!-- Parameters -->
      <div v-if="tab === 'params'" class="space-y-4">
        <div v-if="data.issues?.length" class="rounded-md bg-warn-soft border border-warn/30 p-2.5 text-[12px] text-warn space-y-0.5">
          <div v-for="(i, k) in data.issues" :key="k" class="flex gap-1.5"><AlertTriangle class="size-3.5 shrink-0 mt-0.5" />{{ i }}</div>
        </div>

        <!-- Connection picker for nodes that need credentials -->
        <div v-if="provider">
          <label class="label">Connection<span class="text-bad"> *</span></label>
          <select class="input" :value="data.credentialId ?? ''" :disabled="readonly" @change="emit('update', { credentialId: ($event.target as HTMLSelectElement).value || null })">
            <option value="">Choose a {{ PROVIDER_LABELS[provider] }}…</option>
            <option v-for="c in options" :key="c.credentialId" :value="c.credentialId">
              {{ c.name }}{{ c.details.accountEmail ? ` (${c.details.accountEmail})` : c.details.projectId ? ` (${c.details.projectId})` : '' }}{{ c.status === 'error' ? ' — needs attention' : '' }}
            </option>
          </select>
          <p class="text-[11px] text-subtle mt-1">
            <template v-if="!options.length">No connection yet. </template>
            <RouterLink to="/credentials" target="_blank" class="text-brand hover:underline">Manage connections</RouterLink>
            <template v-if="data.credentialId && options.find((c) => c.credentialId === data.credentialId)?.details.allowedCollections">
              · Allowed: {{ options.find((c) => c.credentialId === data.credentialId)!.details.allowedCollections!.join(', ') }}
            </template>
          </p>
        </div>

        <div v-if="data.nodeType === 'trigger.schedule'" class="rounded-md bg-info-soft text-info text-[12px] p-2.5 leading-relaxed">
          Runs the <b>published</b> version automatically while the workflow is <b>Active</b>. <i>Test run</i> fires it once now.
        </div>
        <div v-if="data.nodeType === 'trigger.event'" class="rounded-md bg-info-soft text-info text-[12px] p-2.5 leading-relaxed">
          Apps send <code class="font-mono">POST /events/{{ (data.config.eventName as string) || 'event.name' }}</code> with an
          <RouterLink to="/credentials" class="underline">event source key</RouterLink>. Every active workflow listening to this name starts.
        </div>
        <div v-if="data.nodeType === 'util.unsupported'" class="rounded-md bg-bad-soft text-bad text-[12px] p-2.5 leading-relaxed">
          This imported node has no equivalent yet. Rebuild it with available nodes (its original settings are below), or delete it.
          The workflow cannot be published while it is here.
        </div>
        <div v-if="codeLocked" class="rounded-md bg-warn-soft text-warn text-[12px] p-2.5">
          Only IT Admins can change code. You can still move this node or edit the rest of the workflow.
        </div>

        <div v-if="data.nodeType === 'trigger.webhook'" class="rounded-md bg-info-soft text-info text-[12px] p-2.5 leading-relaxed">
          The webhook URL is created when the workflow is <b>published</b> and is shown only once.
          <button v-if="published && !readonly" class="mt-1.5 inline-flex items-center gap-1 underline" @click="emit('rotateWebhook')"><RefreshCw class="size-3" />Generate a new URL</button>
        </div>

        <FieldInput v-for="f in visibleFields" :key="f.key" :field="f" :model-value="data.config[f.key]" :readonly="readonly || codeLocked" @update:model-value="setField(f.key, $event)" />
        <p v-if="!visibleFields.length" class="text-[13px] text-muted">This node has no parameters.</p>

        <!-- Plain-English summary of the schedule -->
        <div v-if="schedule" class="rounded-md border border-line bg-surface-2 p-2.5 text-[13px]">
          <div class="flex items-start gap-2">
            <CalendarClock class="size-4 shrink-0 mt-0.5 text-brand" />
            <div>
              <div class="font-medium">{{ schedule.text }}</div>
              <div class="text-[12px] text-subtle">{{ schedule.zone }}</div>
            </div>
          </div>
          <div v-if="schedule.passed" class="mt-2 flex gap-1.5 text-[12px] text-warn">
            <AlertTriangle class="size-3.5 shrink-0 mt-0.5" />This date and time has already passed, so it will not run. Pick a later time.
          </div>
        </div>

        <details class="border-t border-line pt-3">
          <summary class="text-[12px] font-medium text-muted cursor-pointer">Node settings</summary>
          <div class="space-y-3 mt-3">
            <label class="flex items-center gap-2 text-[13px]">
              <input type="checkbox" class="accent-[var(--wb-brand)]" :checked="data.disabled" :disabled="readonly" @change="emit('update', { disabled: ($event.target as HTMLInputElement).checked })" />
              Disable node (pass items through unchanged)
            </label>
            <template v-if="desc?.retryable && !desc.isTrigger">
              <label class="flex items-center gap-2 text-[13px]">
                <input type="checkbox" class="accent-[var(--wb-brand)]" :checked="retryEnabled" :disabled="readonly" @change="emit('update', { retry: ($event.target as HTMLInputElement).checked ? { maxAttempts: 3, backoffMs: 1000 } : undefined })" />
                Retry on failure
              </label>
              <div v-if="data.retry" class="grid grid-cols-2 gap-2 pl-6">
                <div><label class="label">Max attempts</label><input type="number" min="1" max="10" class="input" :value="data.retry.maxAttempts" :readonly="readonly" @change="emit('update', { retry: { ...data.retry!, maxAttempts: Math.min(10, Math.max(1, Number(($event.target as HTMLInputElement).value))) } })" /></div>
                <div><label class="label">First delay (ms)</label><input type="number" min="0" class="input" :value="data.retry.backoffMs" :readonly="readonly" @change="emit('update', { retry: { ...data.retry!, backoffMs: Math.max(0, Number(($event.target as HTMLInputElement).value)) } })" /></div>
                <p class="col-span-2 text-[11px] text-subtle">Only temporary errors (timeouts, 429, 5xx) are retried. The delay doubles each attempt.</p>
              </div>
            </template>
            <div>
              <label class="label">Notes</label>
              <textarea class="textarea" rows="2" :value="data.notes ?? ''" :readonly="readonly" @change="emit('update', { notes: ($event.target as HTMLTextAreaElement).value })" />
            </div>
          </div>
        </details>
      </div>

      <!-- Last run -->
      <div v-else-if="tab === 'output'">
        <p v-if="!step" class="text-[13px] text-muted">Run the workflow or test this node to see its input and output.</p>
        <div v-else class="space-y-3">
          <div class="flex items-center gap-2 text-[12px] text-muted">
            <StatusBadge :status="step.status" />
            <span>{{ formatDuration(step.duration) }}</span>
            <span v-if="step.attempt > 1">· attempt {{ step.attempt }}</span>
          </div>
          <div v-if="step.error" class="rounded-md bg-bad-soft text-bad text-[12px] p-2.5">
            <b>{{ step.error.code ?? 'Error' }}</b>: {{ step.error.message }}
          </div>
          <div><h4 class="label">Input</h4><JsonView :value="step.inputData" max-height="220px" /></div>
          <div><h4 class="label">Output</h4><JsonView :value="step.outputData" max-height="340px" /></div>
        </div>
      </div>

      <!-- Docs -->
      <div v-else class="text-[13px] text-ink leading-relaxed">
        <div v-html="docsHtml" />
        <h4 class="font-semibold text-[13px] mt-4 mb-1">Input</h4>
        <p class="text-muted">{{ desc?.inputSchema.description }}</p>
        <h4 class="font-semibold text-[13px] mt-3 mb-1">Output</h4>
        <p class="text-muted mb-2">{{ desc?.outputSchema.description }}</p>
        <JsonView v-if="desc?.outputSchema.example" :value="desc.outputSchema.example" max-height="200px" />
        <h4 class="font-semibold text-[13px] mt-4 mb-1">Expressions</h4>
        <p class="text-muted" v-pre>Use {{ $json.field }} for the current item, {{ $node["Node name"].json.field }} for another node's first output item, and {{ $trigger.body.field }} for the trigger data.</p>
      </div>
    </div>
  </aside>
</template>
