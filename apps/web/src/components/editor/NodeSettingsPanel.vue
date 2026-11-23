<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { AlertTriangle, Braces, CalendarClock, Check, ClipboardPaste, Copy, FlaskConical, PackagePlus, RefreshCw, Trash2, Users, X } from '@lucide/vue';
import { api } from '@/lib/api';
import type { ExecutionStep, FieldDescriptor } from '@widebed/shared';
import { useNodeTypesStore } from '@/stores/nodeTypes';
import { useCredentialsStore } from '@/stores/credentials';
import { useAuthStore } from '@/stores/auth';
import { CUSTOM_STEP_BLOCKED_TYPES, CUSTOM_STEP_TYPE, PROVIDER_LABELS, TIMEZONE_OPTIONS, describeSchedule, oncePassed, type CredentialProvider, type ScheduleSettings } from '@widebed/shared';
import { useCustomStepsStore } from '@/stores/customSteps';
import Modal from '@/components/ui/Modal.vue';
import FieldInput from '@/components/fields/FieldInput.vue';
import NodeIcon from '@/components/ui/NodeIcon.vue';
import JsonView from '@/components/ui/JsonView.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { formatDuration } from '@/lib/format';
import { toast } from '@/lib/toast';
import type { WbNodeData } from './types';

const props = defineProps<{
  nodeId: string;
  data: WbNodeData;
  step?: ExecutionStep;
  readonly?: boolean;
  published: boolean;
  busy?: boolean;
  /** Webhook Trigger: its URL (editors), when published. */
  webhook?: { url: string | null; signingSecret: string | null } | null;
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
const teamSteps = useCustomStepsStore();

/* ---------- Team steps ("My team's steps") ---------- */
const isTeamStep = computed(() => props.data.nodeType === CUSTOM_STEP_TYPE);
watch(isTeamStep, (t) => t && teamSteps.load().catch(() => undefined), { immediate: true });
const teamStep = computed(() => (isTeamStep.value ? teamSteps.get(props.data.config.stepId) : undefined));
const teamBase = computed(() => (teamStep.value ? store.get(teamStep.value.baseType) : undefined));
const teamValues = computed(() => (props.data.config.values ?? {}) as Record<string, unknown>);
/** The boxes the team may change, shown like the original step's boxes with the names chosen when saving. */
const teamFields = computed(() =>
  (teamStep.value?.fields ?? []).flatMap((f) => {
    const base = teamBase.value?.fields.find((b) => b.key === f.key);
    return base ? [{ ...base, label: f.label, help: f.help || base.help, required: false }] : [];
  }),
);
function teamValue(key: string) {
  return teamValues.value[key] ?? teamStep.value?.baseConfig[key];
}
function setTeamValue(key: string, v: unknown) {
  emit('update', { config: { ...props.data.config, values: { ...teamValues.value, [key]: v } } });
}
/** Turns a team step back into a normal step with all its settings, e.g. to change something only here. */
function unpackTeamStep() {
  const t = teamStep.value;
  if (!t) return;
  const config: Record<string, unknown> = JSON.parse(JSON.stringify(t.baseConfig));
  for (const f of t.fields) if (teamValues.value[f.key] !== undefined && teamValues.value[f.key] !== '') config[f.key] = teamValues.value[f.key];
  emit('update', { nodeType: t.baseType, config, credentialId: t.credentialId ?? null });
  toast('This is now a normal step with all its settings. Changes to the team step no longer reach it.', 'info');
}

const canSaveAsTeamStep = computed(() => {
  const d = store.get(props.data.nodeType);
  return !!d && !props.readonly && auth.can('workflow.create') && !d.isTrigger && !CUSTOM_STEP_BLOCKED_TYPES.includes(d.type) && !d.dynamicOutputs && d.outputs.length === 1;
});
const saving = ref<null | { name: string; description: string; shareWith: 'team' | 'everyone'; fields: Record<string, { on: boolean; label: string }>; useHere: boolean; busy: boolean }>(null);
function openSaveStep() {
  saving.value = {
    name: props.data.name,
    description: '',
    shareWith: 'team',
    fields: Object.fromEntries((desc.value?.fields ?? []).map((f) => [f.key, { on: false, label: f.label }])),
    useHere: true,
    busy: false,
  };
}
async function saveTeamStep() {
  const s = saving.value;
  const d = desc.value;
  if (!s || !d || !s.name.trim()) return;
  s.busy = true;
  try {
    const step = await teamSteps.create({
      name: s.name.trim(),
      description: s.description.trim(),
      baseType: d.type,
      config: props.data.config,
      credentialId: props.data.credentialId ?? null,
      fields: d.fields.filter((f) => s.fields[f.key]?.on).map((f) => ({ key: f.key, label: s.fields[f.key].label.trim() || f.label })),
      shareWith: s.shareWith,
    });
    if (s.useHere) emit('update', { nodeType: CUSTOM_STEP_TYPE, config: { stepId: step.stepId, values: {} }, credentialId: null });
    toast(`Saved. “${step.name}” is now under My team's steps.`, 'success');
    saving.value = null;
  } catch (err) {
    toast((err as Error).message, 'error');
    s.busy = false;
  }
}

const desc = computed(() => store.get(props.data.nodeType));
const creds = useCredentialsStore();
const auth = useAuthStore();
const provider = computed(() => desc.value?.credentialProvider as CredentialProvider | undefined);
const options = computed(() => (provider.value ? creds.byProvider(provider.value) : []));
watch(provider, (p) => p && creds.load().catch(() => undefined), { immediate: true });
const codeLocked = computed(() => props.data.nodeType === 'data.code' && !(auth.profile?.canWriteCode ?? auth.can('node.createCustom')));
const tab = ref<'params' | 'json' | 'output' | 'docs'>('params');

/* ---------- JSON tab: every setting of the step, editable ---------- */
const jsonText = ref('');
const jsonDirty = ref(false);
const jsonMsg = ref<{ ok: boolean; text: string } | null>(null);
function loadJson() {
  jsonText.value = JSON.stringify(props.data.config ?? {}, null, 2);
  jsonDirty.value = false;
  jsonMsg.value = null;
}
watch(() => [tab.value, props.nodeId] as const, ([t]) => t === 'json' && loadJson());
watch(() => props.data.config, () => tab.value === 'json' && !jsonDirty.value && loadJson(), { deep: true });
const jsonParseError = computed(() => {
  try {
    const v = JSON.parse(jsonText.value || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? null : 'The settings must be one JSON object: { … }';
  } catch (e) {
    return (e as Error).message;
  }
});
function applyJson() {
  if (jsonParseError.value) return;
  emit('update', { config: JSON.parse(jsonText.value || '{}') });
  jsonDirty.value = false;
  jsonMsg.value = { ok: true, text: 'Applied. Save the workflow to keep it — problems show on the step.' };
}
function copyJson() {
  navigator.clipboard.writeText(jsonText.value).then(() => toast('Copied', 'success', 1500), () => undefined);
}
const showN8n = ref(false);
const n8nText = ref('');
async function convertN8n() {
  jsonMsg.value = null;
  let node: unknown;
  try {
    node = JSON.parse(n8nText.value);
  } catch {
    jsonMsg.value = { ok: false, text: 'That is not JSON. In n8n select the node, press Ctrl+C, and paste here.' };
    return;
  }
  try {
    const r = await api<{ type: string; name: string; config: Record<string, unknown>; warnings: string[] }>('/workflows/convert-n8n-node', { method: 'POST', body: { node } });
    if (r.type !== props.data.nodeType) {
      const other = store.get(r.type)?.displayName ?? r.type;
      jsonMsg.value = { ok: false, text: `That n8n node becomes a “${other}” step, but this step is “${desc.value?.displayName}”. Add a ${other} step and paste it there.` };
      return;
    }
    jsonText.value = JSON.stringify(r.config, null, 2);
    jsonDirty.value = true;
    showN8n.value = false;
    n8nText.value = '';
    jsonMsg.value = { ok: true, text: `Converted from n8n${r.warnings.length ? ` — check: ${r.warnings.join(' ')}` : ''}. Click Apply.` };
  } catch (err) {
    jsonMsg.value = { ok: false, text: (err as Error).message };
  }
}
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

/** Website chat box code for webhooks that send back a reply. */
const widgetSnippet = computed(
  () => `<script src="${window.location.origin}/chat-widget.js"\n  data-webhook="${props.webhook?.url ?? 'PASTE-THE-WEBHOOK-URL-HERE'}"\n  data-title="Widebed" data-welcome="Hi! How can we help with your stay?"\n  data-color="#1f3a5f" defer><\/script>`,
);
function copyText(text: string | null) {
  if (text) navigator.clipboard.writeText(text).then(() => toast('Copied', 'success', 1500), () => toast('Could not copy — select the text instead', 'error'));
}
function copySnippet() {
  navigator.clipboard.writeText(widgetSnippet.value).then(() => toast('Copied', 'success', 1500), () => toast('Could not copy — select the text instead', 'error'));
}

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
          <p v-if="isTeamStep" class="text-[12px] text-subtle truncate flex items-center gap-1"><Users class="size-3" />Team step{{ teamBase ? ` · built on ${teamBase.displayName}` : '' }}</p>
          <p v-else class="text-[12px] text-subtle truncate">{{ desc?.displayName }} · v{{ desc?.version }}</p>
        </div>
        <button class="btn-ghost btn-icon" aria-label="Close panel" @click="emit('close')"><X class="size-4" /></button>
      </div>
      <div v-if="!readonly" class="flex gap-1.5 mt-3">
        <button class="btn-secondary h-7 text-[12px]" :disabled="busy" title="Run from the trigger up to this node" @click="emit('test')"><FlaskConical class="size-3.5" />Test node</button>
        <button class="btn-ghost h-7 text-[12px]" @click="emit('duplicate')"><Copy class="size-3.5" />Duplicate</button>
        <button v-if="canSaveAsTeamStep" class="btn-ghost h-7 text-[12px]" title="Save this step with its settings so your team can reuse it" @click="openSaveStep"><PackagePlus class="size-3.5" />Save for team</button>
        <button class="btn-ghost h-7 text-[12px] text-bad hover:bg-bad-soft ml-auto" @click="emit('delete')"><Trash2 class="size-3.5" />Delete</button>
      </div>
    </header>

    <div class="flex border-b border-line px-3 gap-4 text-[13px]">
      <button v-for="t in (['params', 'json', 'output', 'docs'] as const)" :key="t" class="h-9 border-b-2 -mb-px inline-flex items-center gap-1" :class="tab === t ? 'border-brand text-ink font-medium' : 'border-transparent text-muted hover:text-ink'" @click="tab = t">
        <Braces v-if="t === 'json'" class="size-3.5" />{{ t === 'params' ? 'Parameters' : t === 'json' ? 'JSON' : t === 'output' ? 'Last run' : 'Docs' }}
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
        <div v-if="data.nodeType === 'data.code'" class="flex flex-wrap gap-1.5 text-[12px]">
          <div class="flex-1 min-w-[96px] rounded-md border border-line px-2.5 py-1.5"><div class="text-subtle text-[11px]">Time limit</div><div class="font-semibold">{{ Math.round(Number(data.config.timeoutMs ?? 5000) / 1000) }} seconds</div></div>
          <div class="flex-1 min-w-[96px] rounded-md border border-line px-2.5 py-1.5"><div class="text-subtle text-[11px]">Memory</div><div class="font-semibold">{{ auth.profile?.codeLimits?.memoryMb ?? 128 }} MB</div></div>
          <div class="flex-1 min-w-[96px] rounded-md border border-line px-2.5 py-1.5"><div class="text-subtle text-[11px]">Internet</div><div class="font-semibold">Off</div></div>
        </div>
        <div v-if="codeLocked" class="rounded-md bg-warn-soft text-warn text-[12px] p-2.5">
          You may not change code here (an Admin decides who can, in Settings → Code steps). You can still move this step or edit the rest of the workflow.
        </div>

        <div v-if="data.nodeType === 'trigger.webhook'" class="rounded-md bg-info-soft text-info text-[12px] p-2.5 leading-relaxed space-y-1.5">
          <template v-if="webhook?.url">
            <div class="font-medium">Webhook URL</div>
            <div class="flex gap-1.5">
              <input class="input font-mono text-[11.5px] bg-surface text-ink" readonly :value="webhook.url" @focus="($event.target as HTMLInputElement).select()" />
              <button class="btn-secondary btn-icon shrink-0" aria-label="Copy webhook URL" @click="copyText(webhook.url)"><Copy class="size-4" /></button>
            </div>
            <div>Only works while the workflow is <b>Active</b>. Anyone with this URL can call it — share it only with the system that needs it.</div>
            <details v-if="webhook.signingSecret" class="text-[11.5px]">
              <summary class="cursor-pointer">Signing secret (only for “Require HMAC signature”)</summary>
              <div class="flex gap-1.5 mt-1"><input class="input font-mono text-[11.5px] bg-surface text-ink" readonly :value="webhook.signingSecret" /><button class="btn-secondary btn-icon shrink-0" aria-label="Copy signing secret" @click="copyText(webhook.signingSecret)"><Copy class="size-4" /></button></div>
            </details>
          </template>
          <template v-else-if="published && webhook && !webhook.url">
            This URL was made before URLs could be shown again. Click <b>Generate a new URL</b> once — after that it is always shown here. (The old URL stops working, so update the caller.)
          </template>
          <template v-else-if="published">Publish again to create the URL for this step.</template>
          <template v-else>The webhook URL is created when the workflow is <b>published</b>, and then shown here.</template>
          <button v-if="published && !readonly" class="inline-flex items-center gap-1 underline" @click="emit('rotateWebhook')"><RefreshCw class="size-3" />Generate a new URL</button>
        </div>
        <div v-if="data.nodeType === 'trigger.webhook' && data.config.responseMode === 'reply'" class="rounded-md border border-line bg-surface-2 p-2.5 text-[12px] leading-relaxed">
          <div class="font-medium mb-1">Chat box for your website</div>
          Paste this before <code class="font-mono">&lt;/body&gt;</code> on your website (or use the all-in-one HTML block from docs/chat-box.html in a page builder).
          Also list the website below under “Websites that may call it”.
          <pre class="font-mono text-[11px] bg-surface border border-line rounded p-2 mt-1.5 whitespace-pre-wrap break-all">{{ widgetSnippet }}</pre>
          <button class="btn-ghost h-7 text-[12px] mt-1" @click="copySnippet"><Copy class="size-3.5" />Copy code</button>
        </div>

        <template v-if="isTeamStep">
          <div class="rounded-md border border-line bg-surface-2 p-2.5 text-[12px] leading-relaxed">
            <template v-if="teamStep">
              <div class="font-medium text-[13px]">{{ teamStep.name }}</div>
              <p v-if="teamStep.description" class="text-muted">{{ teamStep.description }}</p>
              <p class="text-subtle mt-1">
                Saved by {{ teamStep.createdByName || 'a teammate' }}{{ teamStep.department ? ` for ${teamStep.department}` : ' for everyone' }}.
                Everything else is already set up; when they improve the saved step, this workflow gets the change.
              </p>
              <button v-if="!readonly" class="underline mt-1" title="Copy all settings into this workflow so you can change anything" @click="unpackTeamStep">Change all settings here instead</button>
            </template>
            <template v-else-if="teamSteps.loaded">
              <div class="flex gap-1.5 text-warn"><AlertTriangle class="size-3.5 shrink-0 mt-0.5" />This team step was deleted or is not shared with you. Replace it with another step.</div>
            </template>
            <template v-else>Loading the team step…</template>
          </div>
          <FieldInput v-for="f in teamFields" :key="f.key" :field="f" :model-value="teamValue(f.key)" :readonly="readonly" @update:model-value="setTeamValue(f.key, $event)" />
          <p v-if="teamStep && !teamFields.length" class="text-[13px] text-muted">Nothing to fill in — this step is ready to use.</p>
        </template>
        <template v-else>
          <FieldInput v-for="f in visibleFields" :key="f.key" :field="f" :model-value="data.config[f.key]" :readonly="readonly || codeLocked" @update:model-value="setField(f.key, $event)" />
          <p v-if="!visibleFields.length" class="text-[13px] text-muted">This node has no parameters.</p>
        </template>

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

      <!-- JSON: every setting, including ones the form has no box for -->
      <div v-else-if="tab === 'json'" class="space-y-3">
        <p class="text-[12.5px] text-muted leading-relaxed">Every setting of this step as JSON. Change anything — also settings that have no box in the form — then <b>Apply</b>.</p>
        <textarea
          v-model="jsonText"
          class="textarea font-mono text-[12px] leading-relaxed bg-[#0f172a] text-[#e2e8f0] border-[#1e293b]"
          rows="18"
          spellcheck="false"
          aria-label="Step settings as JSON"
          :readonly="readonly || codeLocked"
          @input="jsonDirty = true"
        />
        <p v-if="jsonParseError" class="text-[12px] text-bad">Not valid JSON yet: {{ jsonParseError }}</p>
        <p v-else-if="jsonDirty" class="text-[12px] text-ok inline-flex items-center gap-1"><Check class="size-3.5" />Valid JSON — click Apply</p>
        <div class="flex flex-wrap gap-1.5">
          <button v-if="!readonly && !codeLocked" class="btn-primary h-8 text-[12.5px]" :disabled="!!jsonParseError || !jsonDirty" @click="applyJson">Apply</button>
          <button class="btn-secondary h-8 text-[12.5px]" @click="copyJson"><Copy class="size-3.5" />Copy</button>
          <button v-if="!readonly && !codeLocked" class="btn-secondary h-8 text-[12.5px]" @click="showN8n = !showN8n"><ClipboardPaste class="size-3.5" />Paste from n8n</button>
          <button v-if="jsonDirty" class="btn-ghost h-8 text-[12.5px]" @click="loadJson">Undo changes</button>
        </div>
        <div v-if="showN8n" class="rounded-md border border-line p-2.5 space-y-2">
          <label class="label" for="n8n-paste">n8n node (in n8n: select the node → Ctrl+C)</label>
          <textarea id="n8n-paste" v-model="n8nText" class="textarea font-mono text-[11.5px]" rows="6" spellcheck="false" placeholder='{ "nodes": [ { "name": "HTTP Request", "type": "n8n-nodes-base.httpRequest", "parameters": { … } } ] }' />
          <button class="btn-primary h-8 text-[12.5px]" :disabled="!n8nText.trim()" @click="convertN8n">Convert</button>
        </div>
        <p v-if="jsonMsg" class="text-[12px] leading-snug" :class="jsonMsg.ok ? 'text-ok' : 'text-bad'">{{ jsonMsg.text }}</p>
        <div class="rounded-md bg-warn-soft text-warn text-[12px] p-2.5 leading-relaxed">Connections appear only as their id; keys and passwords are never in the JSON.</div>
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
        <p class="text-muted" v-pre>Use {{ $json.field }} for the current item, {{ $('Step name').item.json.field }} for another step, and {{ $trigger.body.field }} for the trigger data. Formulas work like n8n: {{ $json.name.toUpperCase() }}, {{ $now.format('d MMM yyyy') }}, {{ $json.total > 100 ? 'big' : 'small' }}, {{ $json.items.map(x => x.name).join(', ') }}. Click fx next to a box for help.</p>
      </div>
    </div>
    <Modal v-if="saving" title="Save as a team step" width="520px" @close="saving = null">
      <p class="text-[13px] text-muted mb-3">Turn this step into your own step. Everyone in your team gets it in the step list, with only the boxes you choose.</p>
      <div class="space-y-3">
        <div><label class="label">Name</label><input v-model="saving.name" class="input" maxlength="60" placeholder="e.g. Send to booking system" /></div>
        <div><label class="label">What it does (optional)</label><input v-model="saving.description" class="input" maxlength="300" /></div>
        <div>
          <label class="label">Boxes your team can change</label>
          <p class="text-[12px] text-subtle mb-1.5">Ticked boxes appear when someone uses the step (you can rename them). Everything else stays as it is now, including the connection.</p>
          <div class="space-y-1 max-h-56 overflow-y-auto pr-1">
            <div v-for="f in desc?.fields ?? []" :key="f.key" class="flex items-center gap-2">
              <input :id="`tf-${f.key}`" v-model="saving.fields[f.key].on" type="checkbox" class="accent-[var(--wb-brand)]" />
              <label v-if="!saving.fields[f.key].on" :for="`tf-${f.key}`" class="text-[13px] flex-1">{{ f.label }}</label>
              <input v-else v-model="saving.fields[f.key].label" class="input h-7 text-[13px] flex-1" :aria-label="`Name of the box ${f.label}`" />
            </div>
          </div>
        </div>
        <div>
          <label class="label">Share with</label>
          <label class="flex items-center gap-2 text-[13px]"><input v-model="saving.shareWith" type="radio" value="team" class="accent-[var(--wb-brand)]" />My team{{ auth.profile?.department ? ` (${auth.profile.department})` : '' }}</label>
          <label v-if="auth.can('workflow.viewAll')" class="flex items-center gap-2 text-[13px]"><input v-model="saving.shareWith" type="radio" value="everyone" class="accent-[var(--wb-brand)]" />Everyone in the company</label>
        </div>
        <label class="flex items-center gap-2 text-[13px]"><input v-model="saving.useHere" type="checkbox" class="accent-[var(--wb-brand)]" />Use the saved step here too</label>
      </div>
      <template #footer>
        <button class="btn-ghost" @click="saving = null">Cancel</button>
        <button class="btn-primary" :disabled="saving.busy || !saving.name.trim()" @click="saveTeamStep"><PackagePlus class="size-4" />Save step</button>
      </template>
    </Modal>
  </aside>
</template>
