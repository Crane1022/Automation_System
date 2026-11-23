<script setup lang="ts">
import { clone } from '@/lib/clone';
import { computed, inject, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue';
import { api } from '@/lib/api';
import { Plus, X, Braces } from '@lucide/vue';
import type { FieldDescriptor } from '@widebed/shared';
import { PROVIDER_LABELS, type CredentialProvider } from '@widebed/shared';
import { useCredentialsStore } from '@/stores/credentials';

/** Renders one config field from a node descriptor. */
const props = defineProps<{ field: FieldDescriptor; modelValue: unknown; readonly?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [unknown] }>();

// Field values are dynamic (string, number, list…), so this stays loosely typed.
const value = computed<any>({
  get: () => props.modelValue ?? props.field.default,
  set: (v) => emit('update:modelValue', v),
});

const OPERATORS: { value: string; label: string; unary?: boolean; days?: boolean; group?: string }[] = [
  { value: 'equals', label: 'is equal to' },
  { value: 'notEquals', label: 'is not equal to' },
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'does not contain' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
  { value: 'greaterThan', label: 'is greater than' },
  { value: 'greaterThanOrEqual', label: 'is ≥' },
  { value: 'lessThan', label: 'is less than' },
  { value: 'lessThanOrEqual', label: 'is ≤' },
  { value: 'isEmpty', label: 'is empty', unary: true },
  { value: 'isNotEmpty', label: 'is not empty', unary: true },
  { value: 'isTrue', label: 'is true', unary: true },
  { value: 'isFalse', label: 'is false', unary: true },
  // Dates (whole days, Malaysia time) — work with 2026-12-01, 01/12/2026 and Firebase dates
  { value: 'isToday', label: 'is today', unary: true, group: 'date' },
  { value: 'isTomorrow', label: 'is tomorrow', unary: true, group: 'date' },
  { value: 'isYesterday', label: 'is yesterday', unary: true, group: 'date' },
  { value: 'isInPast', label: 'is before today', unary: true, group: 'date' },
  { value: 'isInFuture', label: 'is after today', unary: true, group: 'date' },
  { value: 'withinNextDays', label: 'is within the next … days', days: true, group: 'date' },
  { value: 'withinLastDays', label: 'was within the last … days', days: true, group: 'date' },
  { value: 'moreThanDaysAgo', label: 'is more than … days ago', days: true, group: 'date' },
  { value: 'isDaysFromToday', label: 'is exactly … days from today', days: true, group: 'date' },
];
const isDays = (op: string) => OPERATORS.find((o) => o.value === op)?.days;
const isUnary = (op: string) => OPERATORS.find((o) => o.value === op)?.unary;

/** multiSelect: the chosen option values, kept in the options' order. */
const picked = computed<string[]>(() => (Array.isArray(value.value) ? (value.value as string[]) : []));
function togglePick(v: string) {
  const set = new Set(picked.value);
  if (set.has(v)) set.delete(v);
  else set.add(v);
  value.value = (props.field.options ?? []).map((o) => o.value).filter((x) => set.has(x));
}

type KV = { key: string; value: unknown };
type Cond = { left: unknown; operator: string; right?: unknown };
const rows = computed<KV[]>(() => (Array.isArray(value.value) ? (value.value as KV[]) : []));
const conds = computed<Cond[]>(() => (Array.isArray(value.value) ? (value.value as Cond[]) : []));
const inputValue = (e: Event) => (e.target as HTMLInputElement | HTMLSelectElement).value;
function setRow(i: number, key: 'key' | 'value', v: string) {
  const l = clone(rows.value);
  l[i][key] = v;
  value.value = l;
}
function removeAt(i: number) {
  const l = clone(value.value as unknown[]);
  l.splice(i, 1);
  value.value = l;
}
type Case = { id: string; label: string; value: unknown };
type Filter = { field: string; op: string; value: unknown };
const cases = computed<Case[]>(() => (Array.isArray(value.value) ? (value.value as Case[]) : []));
const filters = computed<Filter[]>(() => (Array.isArray(value.value) ? (value.value as Filter[]) : []));
const FS_OPS = ['==', '!=', '<', '<=', '>', '>=', 'array-contains', 'in'];
/** Case ids are the output handle ids, so they never change when a case is renamed. */
const newCaseId = () => `c_${Math.random().toString(36).slice(2, 8)}`;
function setCase(i: number, key: 'label' | 'value', v: string) {
  const l = clone(cases.value);
  l[i][key] = v;
  value.value = l;
}
function setFilter(i: number, key: 'field' | 'op' | 'value', v: string) {
  const l = clone(filters.value);
  l[i][key] = v;
  value.value = l;
}

function setCond(i: number, key: 'left' | 'operator' | 'right', v: string) {
  const l = clone(conds.value);
  l[i][key] = v;
  value.value = l;
}

/** credential fields: saved connections of the right kind. */
const creds = useCredentialsStore();
watch(() => props.field.type, (t) => t === 'credential' && creds.load().catch(() => undefined), { immediate: true });
const credOptions = computed(() => (props.field.credentialProvider ? creds.byProvider(props.field.credentialProvider) : []));
const credLabel = computed(() => PROVIDER_LABELS[props.field.credentialProvider as CredentialProvider] ?? 'connection');

/** list fields: small records (e.g. the sheets an AI Chatbot may search). */
type Rec = Record<string, unknown>;
const records = computed<Rec[]>(() => (Array.isArray(value.value) ? (value.value as Rec[]) : []));
function setRecord(i: number, key: string, v: unknown) {
  const l = clone(records.value);
  l[i] = { ...l[i], [key]: v };
  value.value = l;
}
function addRecord() {
  value.value = [...records.value, Object.fromEntries((props.field.itemFields ?? []).map((f) => [f.key, f.default ?? '']))];
}

/* ---------- formulas: fx helper + preview from the last run ---------- */
const formula = inject<{ workflowId: ComputedRef<string>; nodeId: Ref<string | null>; stepNames: ComputedRef<string[]> } | null>('wbFormula', null);
const canFormula = computed(() => !!props.field.expressions && ['string', 'text', 'code'].includes(props.field.type));
const showFx = ref(false);
const preview = ref<{ ok: boolean; text: string; fromRun: boolean } | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => [value.value, formula?.nodeId.value] as const,
  ([v]) => {
    if (timer) clearTimeout(timer);
    if (!formula || !canFormula.value || typeof v !== 'string' || !v.includes('{{') || !formula.nodeId.value) {
      preview.value = null;
      return;
    }
    timer = setTimeout(async () => {
      try {
        const r = await api<{ ok: boolean; value?: unknown; error?: string; fromRun: boolean }>(`/workflows/${formula.workflowId.value}/preview-expression`, {
          method: 'POST',
          body: { nodeId: formula.nodeId.value, value: v },
          quiet: true,
        });
        const shown = r.ok ? (typeof r.value === 'string' ? r.value : JSON.stringify(r.value)) ?? '' : r.error ?? '';
        preview.value = { ok: r.ok, text: shown.length > 300 ? `${shown.slice(0, 300)}…` : shown, fromRun: r.fromRun };
      } catch {
        preview.value = null;
      }
    }, 450);
  },
  { immediate: true },
);
onBeforeUnmount(() => timer && clearTimeout(timer));
const FX_FUNCTIONS: { label: string; insert: string }[] = [
  { label: 'Current item', insert: '{{ $json. }}' },
  { label: 'Today’s date', insert: '{{ $today }}' },
  { label: 'Date format', insert: "{{ $now.format('d MMM yyyy') }}" },
  { label: 'In 3 days', insert: "{{ $now.plus(3, 'days').format('yyyy-MM-dd') }}" },
  { label: 'UPPER CASE', insert: '{{ $json.name.toUpperCase() }}' },
  { label: 'First word', insert: "{{ $json.name.split(' ')[0] }}" },
  { label: 'If … else', insert: "{{ $json.total > 100 ? 'yes' : 'no' }}" },
  { label: 'List → text', insert: "{{ $json.items.map(x => x.name).join(', ') }}" },
  { label: 'Fallback if empty', insert: "{{ $json.name || 'Guest' }}" },
];
function insertFx(text: string) {
  const cur = typeof value.value === 'string' ? value.value : '';
  value.value = cur ? `${cur}${/\s$/.test(cur) ? '' : ' '}${text}` : text;
}

const jsonError = computed(() => {
  if (props.field.type !== 'json' || typeof value.value !== 'string' || !value.value.trim()) return null;
  try {
    JSON.parse(value.value);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
});
</script>

<template>
  <div>
    <div class="flex items-center justify-between">
      <label class="label">{{ field.label }}<span v-if="field.required" class="text-bad"> *</span></label>
      <button
        v-if="canFormula && formula && !readonly"
        type="button"
        class="text-[10.5px] font-semibold font-mono px-1.5 h-5 rounded mb-1 inline-flex items-center gap-0.5 transition-colors"
        :class="showFx ? 'bg-[#6c4a8f] text-white' : 'bg-[#efe8f5] text-[#6c4a8f] hover:bg-[#e4d8f0]'"
        :aria-expanded="showFx"
        title="Insert data or a formula"
        @click="showFx = !showFx"
      >fx</button>
      <span v-else-if="field.expressions" class="text-[10px] text-subtle inline-flex items-center gap-0.5 mb-1" :title="'Supports {{ expressions }}'"><Braces class="size-3" />expr</span>
    </div>

    <input v-if="field.type === 'string'" v-model="value" class="input font-[450]" :placeholder="field.placeholder" :readonly="readonly" />
    <input v-else-if="field.type === 'number'" :value="value" type="number" class="input" :readonly="readonly" @input="value = Number(($event.target as HTMLInputElement).value)" />
    <textarea v-else-if="field.type === 'text'" v-model="value" class="textarea" rows="3" :readonly="readonly" />
    <textarea v-else-if="field.type === 'json' || field.type === 'code'" v-model="value" class="textarea font-mono text-[12px]" rows="6" spellcheck="false" :readonly="readonly" :placeholder="field.placeholder" />
    <label v-else-if="field.type === 'boolean'" class="flex items-center gap-2 text-[13px] h-8">
      <input v-model="value" type="checkbox" class="accent-[var(--wb-brand)] size-4" :disabled="readonly" />
      <span class="text-muted">{{ value ? 'Enabled' : 'Disabled' }}</span>
    </label>
    <select v-else-if="field.type === 'select'" v-model="value" class="input" :disabled="readonly">
      <option v-for="o in field.options" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>

    <!-- Beginner-friendly pickers -->
    <input v-else-if="field.type === 'date'" v-model="value" type="date" class="input" :readonly="readonly" />
    <input v-else-if="field.type === 'time'" v-model="value" type="time" class="input" :readonly="readonly" />
    <div v-else-if="field.type === 'multiSelect'" class="flex flex-wrap gap-1.5" role="group" :aria-label="field.label">
      <button
        v-for="o in field.options"
        :key="o.value"
        type="button"
        class="h-8 min-w-11 px-2.5 rounded-md border text-[12px] font-medium transition-colors"
        :class="picked.includes(o.value) ? 'bg-brand text-white border-brand' : 'bg-surface border-line text-muted hover:text-ink'"
        :aria-pressed="picked.includes(o.value)"
        :disabled="readonly"
        @click="togglePick(o.value)"
      >
        {{ o.label }}
      </button>
    </div>
    <select v-else-if="field.type === 'timezone'" v-model="value" class="input" :disabled="readonly">
      <option v-for="o in field.options" :key="o.value" :value="o.value">{{ o.label }}</option>
      <option v-if="value && !field.options?.some((o) => o.value === value)" :value="value">{{ value }}</option>
    </select>

    <!-- A saved connection (optional unless the node says otherwise) -->
    <template v-else-if="field.type === 'credential'">
      <select v-model="value" class="input" :disabled="readonly">
        <option value="">{{ field.required ? `Choose a ${credLabel}…` : 'None' }}</option>
        <option v-for="c in credOptions" :key="c.credentialId" :value="c.credentialId">
          {{ c.name }}{{ c.details.accountEmail ? ` (${c.details.accountEmail})` : '' }}{{ c.status === 'error' ? ' — needs attention' : '' }}
        </option>
        <option v-if="value && !credOptions.some((c) => c.credentialId === value)" :value="value">Connection you cannot see</option>
      </select>
      <p class="text-[11px] text-subtle mt-1">
        <template v-if="!credOptions.length">No {{ credLabel }} yet. </template>
        <RouterLink to="/credentials" target="_blank" class="text-brand hover:underline">Manage connections</RouterLink>
      </p>
    </template>

    <!-- List of small records -->
    <div v-else-if="field.type === 'list'" class="space-y-2">
      <div v-for="(r, i) in records" :key="i" class="rounded-md border border-line bg-surface-2 p-2 space-y-1.5">
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-medium text-subtle">#{{ i + 1 }} {{ String(r[field.itemFields?.[0]?.key ?? ''] ?? '') }}</span>
          <button v-if="!readonly" class="btn-ghost btn-icon size-6" aria-label="Remove" @click="removeAt(i)"><X class="size-3.5" /></button>
        </div>
        <div v-for="sub in field.itemFields" :key="sub.key">
          <label class="text-[11px] text-muted">{{ sub.label }}<span v-if="sub.required" class="text-bad"> *</span></label>
          <textarea v-if="sub.type === 'text'" :value="String(r[sub.key] ?? '')" class="textarea text-[12px]" rows="2" :placeholder="sub.placeholder" :readonly="readonly" @input="setRecord(i, sub.key, inputValue($event))" />
          <input v-else-if="sub.type === 'number'" :value="r[sub.key] as number" type="number" class="input" :readonly="readonly" @input="setRecord(i, sub.key, Number(inputValue($event)))" />
          <input v-else :value="String(r[sub.key] ?? '')" class="input text-[12px]" :placeholder="sub.placeholder" :readonly="readonly" @input="setRecord(i, sub.key, inputValue($event))" />
        </div>
      </div>
      <button v-if="!readonly" class="btn-ghost h-7 text-[12px]" @click="addRecord"><Plus class="size-3.5" />{{ field.addLabel ?? 'Add' }}</button>
    </div>

    <!-- Key / value list (headers, query) -->
    <div v-else-if="field.type === 'keyValue'" class="space-y-1.5">
      <div v-for="(row, i) in rows" :key="i" class="flex gap-1.5">
        <input :value="row.key" class="input" :placeholder="field.keyPlaceholder ?? 'Name'" :readonly="readonly" @input="setRow(i, 'key', inputValue($event))" />
        <input :value="String(row.value ?? '')" class="input" :placeholder="field.valuePlaceholder ?? 'Value'" :readonly="readonly" @input="setRow(i, 'value', inputValue($event))" />
        <button v-if="!readonly" class="btn-ghost btn-icon shrink-0" aria-label="Remove" @click="removeAt(i)"><X class="size-4" /></button>
      </div>
      <button v-if="!readonly" class="btn-ghost h-7 text-[12px]" @click="value = [...rows, { key: '', value: '' }]"><Plus class="size-3.5" />Add</button>
    </div>

    <!-- IF conditions -->
    <div v-else-if="field.type === 'conditions'" class="space-y-2">
      <div v-for="(c, i) in conds" :key="i" class="rounded-md border border-line bg-surface-2 p-2 space-y-1.5">
        <div class="flex gap-1.5">
          <input :value="String(c.left ?? '')" class="input font-mono text-[12px]" :placeholder="'{{ $json.status }}'" :readonly="readonly" @input="setCond(i, 'left', inputValue($event))" />
          <button v-if="!readonly && conds.length > 1" class="btn-ghost btn-icon shrink-0" aria-label="Remove condition" @click="removeAt(i)"><X class="size-4" /></button>
        </div>
        <select :value="c.operator" class="input" :disabled="readonly" @change="setCond(i, 'operator', inputValue($event))">
          <optgroup label="Text and numbers">
            <option v-for="o in OPERATORS.filter((x) => !x.group)" :key="o.value" :value="o.value">{{ o.label }}</option>
          </optgroup>
          <optgroup label="Dates">
            <option v-for="o in OPERATORS.filter((x) => x.group === 'date')" :key="o.value" :value="o.value">{{ o.label }}</option>
          </optgroup>
        </select>
        <div v-if="isDays(c.operator)" class="flex items-center gap-2">
          <input :value="String(c.right ?? '')" type="number" min="0" class="input w-24" placeholder="3" :readonly="readonly" @input="setCond(i, 'right', inputValue($event))" />
          <span class="text-[12px] text-muted">days</span>
        </div>
        <input v-else-if="!isUnary(c.operator)" :value="String(c.right ?? '')" class="input font-mono text-[12px]" :placeholder="'value or {{ expression }}'" :readonly="readonly" @input="setCond(i, 'right', inputValue($event))" />
      </div>
      <button v-if="!readonly" class="btn-ghost h-7 text-[12px]" @click="value = [...conds, { left: '', operator: 'equals', right: '' }]"><Plus class="size-3.5" />Add condition</button>
    </div>

 <!-- Switch cases -->
    <div v-else-if="field.type === 'cases'" class="space-y-1.5">
      <div class="grid grid-cols-[1fr_1fr_32px] gap-1.5 text-[11px] text-subtle px-0.5"><span>{{ field.columnLabels?.[0] ?? 'Output name' }}</span><span>{{ field.columnLabels?.[1] ?? 'Matches value' }}</span><span /></div>
      <div v-for="(c, i) in cases" :key="c.id" class="grid grid-cols-[1fr_1fr_32px] gap-1.5">
        <input :value="c.label" class="input" :placeholder="field.keyPlaceholder ?? 'Confirmed'" maxlength="60" :readonly="readonly" @input="setCase(i, 'label', inputValue($event))" />
        <input :value="String(c.value ?? '')" class="input text-[12px]" :class="{ 'font-mono': !field.columnLabels }" :placeholder="field.valuePlaceholder ?? 'confirmed'" :readonly="readonly" @input="setCase(i, 'value', inputValue($event))" />
        <button v-if="!readonly && cases.length > 1" class="btn-ghost btn-icon" aria-label="Remove case" @click="removeAt(i)"><X class="size-4" /></button>
      </div>
      <button v-if="!readonly && cases.length < 20" class="btn-ghost h-7 text-[12px]" @click="value = [...cases, { id: newCaseId(), label: '', value: '' }]"><Plus class="size-3.5" />{{ field.addLabel ?? 'Add case' }}</button>
    </div>

    <!-- Firestore filters -->
    <div v-else-if="field.type === 'firestoreFilters'" class="space-y-1.5">
      <div v-for="(f, i) in filters" :key="i" class="grid grid-cols-[1fr_88px_1fr_32px] gap-1.5">
        <input :value="f.field" class="input" placeholder="field" :readonly="readonly" @input="setFilter(i, 'field', inputValue($event))" />
        <select :value="f.op" class="input px-1.5" :disabled="readonly" @change="setFilter(i, 'op', inputValue($event))">
          <option v-for="o in FS_OPS" :key="o" :value="o">{{ o }}</option>
        </select>
        <input :value="String(f.value ?? '')" class="input font-mono text-[12px]" placeholder="value" :readonly="readonly" @input="setFilter(i, 'value', inputValue($event))" />
        <button v-if="!readonly" class="btn-ghost btn-icon" aria-label="Remove filter" @click="removeAt(i)"><X class="size-4" /></button>
      </div>
      <button v-if="!readonly" class="btn-ghost h-7 text-[12px]" @click="value = [...filters, { field: '', op: '==', value: '' }]"><Plus class="size-3.5" />Add filter</button>
      <p class="text-[11px] text-subtle">Numbers and true/false are converted automatically. For “in”, use a JSON list like ["a","b"].</p>
    </div>

    <div v-if="showFx && formula" class="mt-1.5 rounded-md border border-line bg-surface shadow-sm text-[12px] overflow-hidden">
      <div class="px-2.5 py-1.5 bg-surface-2 border-b border-line text-muted font-medium">Insert data · click to add</div>
      <div class="grid grid-cols-2">
        <div class="p-2 border-r border-line space-y-1 max-h-48 overflow-y-auto">
          <div class="text-[10.5px] font-bold text-subtle tracking-wide">STEPS</div>
          <button v-for="n in formula.stepNames.value" :key="n" type="button" class="block w-full text-left font-mono text-[11.5px] text-[#7c3aed] hover:underline truncate" @click="insertFx(`{{ $('${n.replace(/'/g, '\\\'')}').item.json. }}`)">$('{{ n }}')</button>
          <button type="button" class="block font-mono text-[11.5px] text-[#7c3aed] hover:underline" @click="insertFx('{{ $json. }}')">$json</button>
        </div>
        <div class="p-2 space-y-1 max-h-48 overflow-y-auto">
          <div class="text-[10.5px] font-bold text-subtle tracking-wide">FORMULAS</div>
          <button v-for="f in FX_FUNCTIONS" :key="f.label" type="button" class="block w-full text-left text-[11.5px] text-[#b45309] hover:underline truncate" :title="f.insert" @click="insertFx(f.insert)">{{ f.label }}</button>
        </div>
      </div>
      <div class="px-2.5 py-1.5 border-t border-line text-[11px] text-subtle">Works like n8n: <span class="font-mono">$('Step').item.json.x</span>, <span class="font-mono">.toUpperCase()</span>, <span class="font-mono">a ? b : c</span>. Formulas cannot reach the internet or files.</div>
    </div>
    <p v-if="preview" class="text-[11px] mt-1 leading-snug break-words" :class="preview.ok ? 'text-ok' : 'text-bad'">
      <template v-if="preview.ok && preview.fromRun">Preview from the last run: <span class="font-mono bg-ok-soft px-1 rounded">{{ preview.text === '' ? '(empty)' : preview.text }}</span></template>
      <template v-else-if="preview.ok">Preview (no run yet): <span class="font-mono">{{ preview.text === '' ? '(empty)' : preview.text }}</span></template>
      <template v-else>Formula problem: {{ preview.text }}</template>
    </p>
    <p v-if="jsonError" class="text-[11px] text-bad mt-1">Invalid JSON: {{ jsonError }}</p>
    <p v-else-if="field.help" class="text-[11px] text-subtle mt-1 leading-snug">{{ field.help }}</p>
  </div>
</template>
