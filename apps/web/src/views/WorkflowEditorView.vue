<script setup lang="ts">
import GuideButton from '@/components/ui/GuideButton.vue';
import { clone } from '@/lib/clone';
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { VueFlow, useVueFlow, MarkerType, type Connection, type NodeChange, type EdgeChange } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { MiniMap } from '@vue-flow/minimap';
import {
  AlertTriangle, ArrowLeft, Check, Copy, CopyPlus, Download, GitCompare, Hand, History, Loader2, Maximize, MousePointer2, Network, Play, Plus,
  Redo2, Rocket, Save, Settings2, Spline, SquareDashedMousePointer, Trash2, Undo2, X,
} from '@lucide/vue';
import { CUSTOM_STEP_TYPE, resolveOutputs, type HandleDescriptor } from '@widebed/shared';
import type {
  Execution, ExecutionStep, NodeDescriptor, ValidationIssue, Workflow, WorkflowDefinition, WorkflowVersion,
} from '@widebed/shared';
import { api } from '@/lib/api';
import { downloadJson, fileSlug } from '@/lib/download';
import { streamEvents } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';
import { formatDate, timeAgo } from '@/lib/format';
import { useNodeTypesStore } from '@/stores/nodeTypes';
import { useCustomStepsStore, type TeamStep } from '@/stores/customSteps';
import WorkflowNode from '@/components/editor/WorkflowNode.vue';
import NodePalette from '@/components/editor/NodePalette.vue';
import NodeSettingsPanel from '@/components/editor/NodeSettingsPanel.vue';
import ExecutionPanel from '@/components/editor/ExecutionPanel.vue';
import Modal from '@/components/ui/Modal.vue';
import VersionCompare from '@/components/editor/VersionCompare.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import type { WbNodeData } from '@/components/editor/types';

type WorkflowWithPerms = Workflow & { permissions: { edit: boolean; run: boolean; publish: boolean } };
interface IssuedWebhook { webhookId: string; nodeId: string; url: string; signingSecret: string }

const route = useRoute();
const router = useRouter();
const store = useNodeTypesStore();
const teamSteps = useCustomStepsStore();
const flowId = 'wb-editor';
const {
  nodes, edges, addNodes, addEdges, removeNodes, removeEdges, setNodes, setEdges, updateNodeData, findNode,
  screenToFlowCoordinate, fitView, onConnect, vueFlowRef, getSelectedNodes, getSelectedEdges, removeSelectedNodes,
} = useVueFlow(flowId);

const wf = ref<WorkflowWithPerms | null>(null);
const loadError = ref<string | null>(null);
const selectedId = ref<string | null>(null);
const dirty = ref(false);
const saving = ref(false);
const savedAt = ref<string | null>(null);
const issues = ref<ValidationIssue[]>([]);
const showIssues = ref(false);

const execution = ref<Execution | null>(null);
const steps = ref<ExecutionStep[]>([]);
const showExecPanel = ref(false);
const runError = ref<string | null>(null);
const running = computed(() => !!execution.value && ['pending', 'queued', 'running'].includes(execution.value.status));
let stopStream: (() => void) | null = null;

const showVersions = ref(false);
const versions = ref<(Omit<WorkflowVersion, 'nodes' | 'connections'> & { nodeCount: number })[]>([]);
const issued = ref<IssuedWebhook[] | null>(null);
/** Webhook URLs per trigger node id, shown in the Webhook step (editors only). url null = made before URLs were kept. */
const webhookUrls = ref<Record<string, { url: string | null; signingSecret: string | null }>>({});
async function loadWebhooks() {
  if (!wf.value?.publishedVersionId || !wf.value.permissions.edit) return;
  try {
    const res = await api<{ items: { nodeId: string; url: string | null; signingSecret: string | null }[] }>(`/workflows/${wf.value.workflowId}/webhooks`);
    webhookUrls.value = Object.fromEntries(res.items.map((w) => [w.nodeId, { url: w.url, signingSecret: w.signingSecret }]));
  } catch {
    /* the panel just shows no URL */
  }
}

/* Workflow settings: timeout and default retry policy (saved with the draft). */
const showSettings = ref(false);
const settingsForm = ref({ timeoutMin: '', retryOn: false, maxAttempts: 3, backoffMs: 1000 });
function openSettings() {
  const st = wf.value?.draftDefinition.settings ?? {};
  settingsForm.value = {
    timeoutMin: st.timeoutMs ? String(Math.round(st.timeoutMs / 60000)) : '',
    retryOn: !!st.defaultRetry,
    maxAttempts: st.defaultRetry?.maxAttempts ?? 3,
    backoffMs: st.defaultRetry?.backoffMs ?? 1000,
  };
  showSettings.value = true;
}
function applySettings() {
  if (!wf.value) return;
  const f = settingsForm.value;
  const minutes = Number(f.timeoutMin);
  wf.value.draftDefinition.settings = {
    ...(minutes > 0 ? { timeoutMs: Math.round(minutes * 60000) } : {}),
    ...(f.retryOn ? { defaultRetry: { maxAttempts: Math.min(10, Math.max(1, Number(f.maxAttempts))), backoffMs: Math.max(0, Number(f.backoffMs)) } } : {}),
  };
  showSettings.value = false;
  commit();
}

const canEdit = computed(() => !!wf.value?.permissions.edit);
const workflowId = computed(() => String(route.params.id));
// Lets field inputs preview {{ formulas }} and list the steps they can use.
provide('wbFormula', {
  workflowId,
  nodeId: selectedId,
  stepNames: computed(() => nodes.value.filter((n) => n.id !== selectedId.value).map((n) => (n.data as WbNodeData).name)),
});
const selectedNode = computed(() => (selectedId.value ? findNode<WbNodeData>(selectedId.value) : undefined));
const selectedStep = computed(() => [...steps.value].reverse().find((s) => s.nodeId === selectedId.value));
const errorCount = computed(() => issues.value.filter((i) => i.severity === 'error').length);
const graphIssues = computed(() => issues.value.filter((i) => !i.nodeId));

/* ---------------- definition <-> canvas ---------------- */

const newId = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

function toDefinition(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: nodes.value.map((n) => {
      const d = n.data as WbNodeData;
      return {
        id: n.id,
        type: d.nodeType,
        name: d.name,
        position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
        config: d.config,
        ...(d.disabled ? { disabled: true } : {}),
        ...(d.retry ? { retry: d.retry } : {}),
        ...(d.credentialId ? { credentialId: d.credentialId } : {}),
        ...(d.notes ? { notes: d.notes } : {}),
      };
    }),
    connections: edges.value.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? 'main',
      target: e.target,
      targetHandle: e.targetHandle ?? 'main',
    })),
    settings: wf.value?.draftDefinition.settings ?? {},
  };
}

const edgeStyle = { type: 'smoothstep', markerEnd: MarkerType.ArrowClosed };

function loadDefinition(def: WorkflowDefinition) {
  setNodes(
    def.nodes.map((n) => ({
      id: n.id,
      type: 'wb',
      position: n.position,
      data: { nodeType: n.type, name: n.name, config: n.config ?? {}, disabled: n.disabled, retry: n.retry, credentialId: n.credentialId, notes: n.notes } satisfies WbNodeData,
    })),
  );
  setEdges(def.connections.map((c) => ({ ...c, ...edgeStyle })));
}

/* ---------------- undo / redo ---------------- */

const past = ref<string[]>([]);
const future = ref<string[]>([]);
let current = '';
let restoring = false;

function snapshot() {
  return JSON.stringify(toDefinition());
}
function resetHistory() {
  past.value = [];
  future.value = [];
  current = snapshot();
}
/** Records the current state as one undo step. Call after every user change. */
function commit() {
  if (restoring) return;
  const s = snapshot();
  if (s === current) return;
  past.value.push(current);
  if (past.value.length > 100) past.value.shift();
  future.value = [];
  current = s;
  dirty.value = true;
  scheduleValidate();
}
function restore(s: string) {
  restoring = true;
  loadDefinition(JSON.parse(s));
  current = s;
  dirty.value = true;
  nextTick(() => (restoring = false));
  scheduleValidate();
}
function undo() {
  const prev = past.value.pop();
  if (prev === undefined) return;
  future.value.push(current);
  restore(prev);
}
function redo() {
  const next = future.value.pop();
  if (next === undefined) return;
  past.value.push(current);
  restore(next);
}

/* ---------------- validation (backend is the source of truth) ---------------- */

let validateTimer: number | undefined;
function scheduleValidate() {
  clearTimeout(validateTimer);
  validateTimer = window.setTimeout(validate, 500);
}
async function validate() {
  if (!wf.value) return;
  try {
    const res = await api<{ issues: ValidationIssue[] }>(`/workflows/${wf.value.workflowId}/validate`, { method: 'POST', body: { definition: toDefinition() } });
    applyIssues(res.issues);
  } catch {
    /* validation is advisory */
  }
}
function applyIssues(list: ValidationIssue[]) {
  issues.value = list;
  for (const n of nodes.value) {
    const mine = list.filter((i) => i.nodeId === n.id && i.severity === 'error').map((i) => i.message.replace(`${(n.data as WbNodeData).name}: `, ''));
    updateNodeData(n.id, { issues: mine });
  }
}

/* ---------------- canvas interactions ---------------- */

function uniqueName(base: string, except?: string) {
  const taken = new Set(nodes.value.filter((n) => n.id !== except).map((n) => (n.data as WbNodeData).name));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

function defaultConfig(d: NodeDescriptor) {
  return Object.fromEntries(d.fields.filter((f) => f.default !== undefined).map((f) => [f.key, clone(f.default)]));
}

function addNode(d: NodeDescriptor, position?: { x: number; y: number }) {
  if (!canEdit.value) return;
  if (d.isTrigger && nodes.value.some((n) => (n.data as WbNodeData).nodeType === d.type)) {
    toast(`This workflow already has a ${d.displayName}.`, 'info');
    return;
  }
  const id = newId('node');
  let pos = position;
  if (!pos) {
    const rect = vueFlowRef.value?.getBoundingClientRect();
    pos = rect ? screenToFlowCoordinate({ x: rect.left + rect.width / 2 - 110, y: rect.top + rect.height / 2 - 30 }) : { x: 100, y: 100 };
    pos = { x: pos.x + (nodes.value.length % 5) * 24, y: pos.y + (nodes.value.length % 5) * 24 };
  }
  addNodes([{ id, type: 'wb', position: pos, data: { nodeType: d.type, name: uniqueName(d.displayName), config: defaultConfig(d) } satisfies WbNodeData }]);
  selectedId.value = id;
  nextTick(commit);
}

/** Adds a step saved by the team ("My team's steps"). */
function addTeamStep(t: TeamStep, position?: { x: number; y: number }) {
  if (!canEdit.value) return;
  const id = newId('node');
  let pos = position;
  if (!pos) {
    const rect = vueFlowRef.value?.getBoundingClientRect();
    pos = rect ? screenToFlowCoordinate({ x: rect.left + rect.width / 2 - 110, y: rect.top + rect.height / 2 - 30 }) : { x: 100, y: 100 };
    pos = { x: pos.x + (nodes.value.length % 5) * 24, y: pos.y + (nodes.value.length % 5) * 24 };
  }
  addNodes([{ id, type: 'wb', position: pos, data: { nodeType: CUSTOM_STEP_TYPE, name: uniqueName(t.name), config: { stepId: t.stepId, values: {} } } satisfies WbNodeData }]);
  selectedId.value = id;
  nextTick(commit);
}

function onDrop(e: DragEvent) {
  const stepId = e.dataTransfer?.getData('application/wb-step');
  const team = stepId ? teamSteps.get(stepId) : undefined;
  if (team) return addTeamStep(team, screenToFlowCoordinate({ x: e.clientX - 110, y: e.clientY - 28 }));
  const type = e.dataTransfer?.getData('application/wb-node');
  const d = type ? store.get(type) : undefined;
  if (!d) return;
  addNode(d, screenToFlowCoordinate({ x: e.clientX - 110, y: e.clientY - 28 }));
}

function isValidConnection(c: Connection) {
  if (c.source === c.target) return false;
  return !edges.value.some((e) => e.source === c.source && e.target === c.target && (e.sourceHandle ?? 'main') === (c.sourceHandle ?? 'main'));
}

onConnect((c) => {
  if (!canEdit.value || !isValidConnection(c)) return;
  addEdges([{ ...c, id: newId('edge'), sourceHandle: c.sourceHandle ?? 'main', targetHandle: c.targetHandle ?? 'main', ...edgeStyle }]);
  nextTick(commit);
});

function onNodesChange(changes: NodeChange[]) {
  if (changes.some((c) => c.type === 'remove')) {
    if (changes.some((c) => c.type === 'remove' && c.id === selectedId.value)) selectedId.value = null;
    nextTick(commit);
  }
}
function onEdgesChange(changes: EdgeChange[]) {
  if (changes.some((c) => c.type === 'remove')) nextTick(commit);
}

function updateSelected(patch: Partial<WbNodeData>) {
  if (!selectedId.value) return;
  if (patch.name) patch.name = uniqueName(patch.name, selectedId.value);
  updateNodeData(selectedId.value, patch);
  commitSoon();
}
let commitTimer: number | undefined;
function commitSoon() {
  clearTimeout(commitTimer);
  commitTimer = window.setTimeout(commit, 350);
}

/** Deletes the selected nodes and lines (or the node open in the side panel). */
function deleteSelected() {
  if (!canEdit.value) return;
  const nodeIds = new Set(getSelectedNodes.value.map((n) => n.id));
  if (selectedId.value) nodeIds.add(selectedId.value);
  const edgeIds = getSelectedEdges.value.map((e) => e.id);
  if (!nodeIds.size && !edgeIds.length) return toast('Select a node or a line first.', 'info', 2000);
  if (edgeIds.length) removeEdges(edgeIds);
  if (nodeIds.size) removeNodes([...nodeIds], true);
  selectedId.value = null;
  nextTick(commit);
}

/** Duplicates the selected nodes (triggers are skipped: one of each per workflow). */
function duplicateSelected() {
  if (!canEdit.value) return;
  const picked = getSelectedNodes.value.length ? getSelectedNodes.value : selectedNode.value ? [selectedNode.value] : [];
  if (!picked.length) return toast('Select a node first.', 'info', 2000);
  const copies = picked.filter((n) => !store.get((n.data as WbNodeData).nodeType)?.isTrigger);
  if (!copies.length) return toast('A workflow can only have one trigger of each type.', 'info');
  const added = copies.map((n) => {
    const data = n.data as WbNodeData;
    const id = newId('node');
    addNodes([{ id, type: 'wb', position: { x: n.position.x + 40, y: n.position.y + 60 }, data: { ...clone({ ...data, exec: undefined, issues: undefined }), name: uniqueName(data.name) } }]);
    return id;
  });
  removeSelectedNodes(getSelectedNodes.value);
  selectedId.value = added.length === 1 ? added[0] : null;
  nextTick(commit);
}

/* ---------------- canvas toolbar ---------------- */

type Tool = 'select' | 'pan' | 'box' | 'connect';
const tool = ref<Tool>('select');
const palette = ref<InstanceType<typeof NodePalette> | null>(null);
/** Draw-line tool: the node the line starts from, and which of its outputs. */
const connectFrom = ref<{ nodeId: string; outputs: HandleDescriptor[]; handle: string | null } | null>(null);

function setTool(t: Tool) {
  if (!canEdit.value && t !== 'select' && t !== 'pan') return;
  tool.value = t;
  connectFrom.value = null;
}
const toolHint = computed(() => {
  switch (tool.value) {
    case 'pan': return 'Drag anywhere to move around the canvas';
    case 'box': return 'Drag a box to select several nodes';
    case 'connect':
      if (!connectFrom.value) return 'Click the node the line starts from';
      if (!connectFrom.value.handle) return 'Choose which output to connect';
      return `Now click the node to connect ${nodeName(connectFrom.value.nodeId)} to`;
    default: return '';
  }
});

function outputsOf(nodeId: string): HandleDescriptor[] {
  const data = findNode<WbNodeData>(nodeId)?.data;
  const d = data ? store.get(data.nodeType) : undefined;
  return d && data ? resolveOutputs(d, data.config) : [{ id: 'main' }];
}

function onNodeClick(nodeId: string) {
  if (tool.value !== 'connect') {
    selectedId.value = nodeId;
    return;
  }
  const from = connectFrom.value;
  if (!from || from.nodeId === nodeId) {
    const outs = outputsOf(nodeId);
    if (!outs.length) return toast('This node has no outputs to connect from.', 'info', 2000);
    connectFrom.value = from?.nodeId === nodeId ? null : { nodeId, outputs: outs, handle: outs.length === 1 ? outs[0].id : null };
    return;
  }
  if (!from.handle) return toast('Choose which output to connect first.', 'info', 2000);
  const target = findNode<WbNodeData>(nodeId);
  const inputs = target ? store.get(target.data.nodeType)?.inputs ?? [] : [];
  if (!inputs.length) return toast(`${nodeName(nodeId)} is a trigger — nothing can connect into it.`, 'info');
  const c = { source: from.nodeId, sourceHandle: from.handle, target: nodeId, targetHandle: inputs[0].id };
  if (!isValidConnection(c as Connection)) return toast('Those nodes are already connected.', 'info', 2000);
  addEdges([{ ...c, id: newId('edge'), ...edgeStyle }]);
  connectFrom.value = null;
  nextTick(commit);
}
function onPaneClick() {
  selectedId.value = null;
  connectFrom.value = null;
}

/** Lays nodes out left to right by how many steps they are from the start. */
function autoArrange() {
  if (!canEdit.value || !nodes.value.length) return;
  const incoming = new Map<string, string[]>();
  for (const e of edges.value) incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source]);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) return 0; // loop: stop here
    visiting.add(id);
    const d = Math.max(-1, ...(incoming.get(id) ?? []).map(depthOf)) + 1;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  const columns = new Map<number, typeof nodes.value>();
  for (const n of [...nodes.value].sort((a, b) => a.position.y - b.position.y)) {
    const d = depthOf(n.id);
    columns.set(d, [...(columns.get(d) ?? []), n]);
  }
  const tallest = Math.max(...[...columns.values()].map((c) => c.length));
  for (const [col, list] of columns) {
    const offset = ((tallest - list.length) * 120) / 2;
    list.forEach((n, row) => (n.position = { x: col * 290, y: offset + row * 120 }));
  }
  nextTick(() => {
    fitView({ padding: 0.3, maxZoom: 1, duration: 300 });
    commit();
  });
}
const fitToScreen = () => fitView({ padding: 0.3, maxZoom: 1, duration: 300 });
const focusAdd = () => palette.value?.focusSearch();

/* ---------------- load / save / publish ---------------- */

async function load() {
  try {
    await store.load();
    wf.value = await api<WorkflowWithPerms>(`/workflows/${workflowId.value}`);
    loadDefinition(wf.value.draftDefinition);
    await nextTick();
    resetHistory();
    dirty.value = false;
    savedAt.value = wf.value.updatedAt;
    if (wf.value.draftDefinition.nodes.length) setTimeout(() => fitView({ padding: 0.3, maxZoom: 1 }), 50);
    validate();
    loadWebhooks();
  } catch (err) {
    loadError.value = (err as Error).message;
  }
}

async function save(silent = false) {
  if (!wf.value || !canEdit.value) return true;
  saving.value = true;
  try {
    const res = await api<{ updatedAt: string; issues: ValidationIssue[] }>(`/workflows/${wf.value.workflowId}/draft`, { method: 'PUT', body: { definition: toDefinition() } });
    wf.value.draftDefinition = toDefinition();
    dirty.value = false;
    savedAt.value = res.updatedAt;
    applyIssues(res.issues);
    if (!silent) toast('Draft saved', 'success', 2000);
    return true;
  } catch (err) {
    toastError(err);
    return false;
  } finally {
    saving.value = false;
  }
}

async function publish() {
  if (!wf.value) return;
  if (dirty.value && !(await save(true))) return;
  try {
    const res = await api<{ version: WorkflowVersion; issuedWebhooks: IssuedWebhook[]; warnings: ValidationIssue[] }>(`/workflows/${wf.value.workflowId}/publish`, { method: 'POST' });
    wf.value.publishedVersion = res.version.versionNumber;
    wf.value.publishedVersionId = res.version.versionId;
    wf.value.publishedAt = res.version.publishedAt;
    toast(`Published version ${res.version.versionNumber}`, 'success');
    if (res.issuedWebhooks.length) issued.value = res.issuedWebhooks;
    loadWebhooks();
  } catch (err: any) {
    if (err?.details) applyIssues(err.details);
    showIssues.value = true;
    toastError(err);
  }
}

async function toggleActive() {
  if (!wf.value) return;
  const next = wf.value.status === 'active' ? 'deactivate' : 'activate';
  try {
    const res = await api<{ status: 'active' | 'inactive' }>(`/workflows/${wf.value.workflowId}/${next}`, { method: 'POST' });
    wf.value.status = res.status;
    toast(res.status === 'active' ? 'Workflow is active — triggers will start it' : 'Workflow deactivated', 'success');
  } catch (err) {
    toastError(err);
  }
}

async function rename(name: string) {
  if (!wf.value || !name.trim() || name === wf.value.name) return;
  try {
    await api(`/workflows/${wf.value.workflowId}`, { method: 'PATCH', body: { name: name.trim() } });
    wf.value.name = name.trim();
  } catch (err) {
    toastError(err);
  }
}

async function exportFile() {
  if (!wf.value) return;
  if (dirty.value && !(await save(true))) return;
  try {
    downloadJson(await api(`/workflows/${wf.value.workflowId}/export`), `${fileSlug(wf.value.name)}.widebed.json`);
  } catch (err) {
    toastError(err);
  }
}

async function openVersions() {
  showVersions.value = true;
  try {
    versions.value = (await api<{ items: typeof versions.value }>(`/workflows/${workflowId.value}/versions`)).items;
  } catch (err) {
    toastError(err);
  }
}

/* Compare: a version with the one before it, or the live version with the current draft. */
const comparing = ref<{ before: WorkflowDefinition; after: WorkflowDefinition; beforeLabel: string; afterLabel: string } | null>(null);
const versionCache = new Map<number, WorkflowVersion>();
async function fetchVersion(n: number) {
  if (!versionCache.has(n)) versionCache.set(n, await api<WorkflowVersion>(`/workflows/${workflowId.value}/versions/${n}`));
  return versionCache.get(n)!;
}
const asDef = (v: WorkflowVersion): WorkflowDefinition => ({ schemaVersion: 1, nodes: v.nodes, connections: v.connections, settings: v.settings ?? {} });
async function compareWithPrevious(n: number) {
  try {
    const after = await fetchVersion(n);
    const before = n > 1 ? await fetchVersion(n - 1) : null;
    comparing.value = {
      before: before ? asDef(before) : { schemaVersion: 1, nodes: [], connections: [], settings: {} },
      after: asDef(after),
      beforeLabel: before ? `v${n - 1}` : 'Empty',
      afterLabel: `v${n}`,
    };
  } catch (err) {
    toastError(err);
  }
}
async function compareDraftWithLive() {
  if (!wf.value?.publishedVersion) return;
  try {
    comparing.value = { before: asDef(await fetchVersion(wf.value.publishedVersion)), after: toDefinition(), beforeLabel: `Live v${wf.value.publishedVersion}`, afterLabel: dirty.value ? 'Your draft (unsaved)' : 'Your draft' };
  } catch (err) {
    toastError(err);
  }
}

async function restoreVersion(n: number) {
  if (dirty.value && !confirm('Discard unsaved changes and load this version into the draft?')) return;
  try {
    await api(`/workflows/${workflowId.value}/versions/${n}/restore`, { method: 'POST' });
    showVersions.value = false;
    await load();
    toast(`Version ${n} loaded into the draft`, 'success');
  } catch (err) {
    toastError(err);
  }
}

async function rotateWebhook() {
  if (!selectedId.value || !confirm('Generate a new URL? The current URL will stop working immediately.')) return;
  try {
    issued.value = [await api<IssuedWebhook>(`/workflows/${workflowId.value}/webhooks/${selectedId.value}/rotate`, { method: 'POST' })];
    loadWebhooks();
  } catch (err) {
    toastError(err);
  }
}

/* ---------------- running ---------------- */

function clearRunState() {
  stopStream?.();
  runError.value = null;
  steps.value = [];
  for (const n of nodes.value) updateNodeData(n.id, { exec: undefined });
  for (const e of edges.value) e.class = undefined;
}

function applyStep(step: ExecutionStep) {
  const i = steps.value.findIndex((s) => s.stepId === step.stepId);
  if (i === -1) steps.value.push(step);
  else steps.value[i] = step;
  const out = step.outputData as Record<string, unknown[]> | null;
  const counts = out && typeof out === 'object' && !('truncated' in out) ? Object.values(out).filter(Array.isArray).reduce((a, l) => a + l.length, 0) : undefined;
  updateNodeData(step.nodeId, { exec: { status: step.status, items: step.status === 'success' ? counts : undefined, error: step.error?.message ?? null, attempt: step.attempt } });
  if (step.status === 'success' && out) {
    for (const e of edges.value) {
      if (e.source === step.nodeId && Array.isArray(out[e.sourceHandle ?? 'main']) && out[e.sourceHandle ?? 'main'].length) e.class = 'wb-edge-active';
    }
  }
}

let notifiedFor: string | null = null;
function notifyFinished(status: string, summary?: string | null) {
  if (!execution.value || notifiedFor === execution.value.executionId) return;
  if (status === 'success') toast('Execution finished successfully', 'success', 2500);
  else if (status === 'failed') toast(summary ?? 'Execution failed', 'error');
  else if (status === 'cancelled') toast('Execution cancelled', 'info');
  else return;
  notifiedFor = execution.value.executionId;
}

function follow(executionId: string) {
  stopStream = streamEvents(`/executions/${executionId}/stream`, (type, data) => {
    if (type === 'snapshot') {
      execution.value = data.execution;
      (data.steps as ExecutionStep[]).forEach(applyStep);
      // Fast runs can finish before the stream connects: the snapshot is then the final state.
      notifyFinished(data.execution.status, data.execution.errorSummary);
    } else if (type === 'execution.status') {
      if (execution.value) Object.assign(execution.value, { status: data.status, errorSummary: data.errorSummary ?? execution.value.errorSummary, duration: data.duration ?? execution.value.duration });
      notifyFinished(data.status, data.errorSummary);
    } else if (type === 'step.started' || type === 'step.finished') {
      applyStep(data.step);
    }
  });
}

async function run(nodeId?: string) {
  if (!wf.value || running.value) return;
  if (dirty.value && !(await save(true))) return;
  clearRunState();
  showExecPanel.value = true;
  try {
    const path = nodeId ? `/workflows/${wf.value.workflowId}/nodes/${nodeId}/test` : `/workflows/${wf.value.workflowId}/run`;
    const res = await api<{ executionId: string }>(path, { method: 'POST', body: { mode: 'draft' } });
    execution.value = { executionId: res.executionId, status: 'queued', duration: null, errorSummary: null } as Execution;
    follow(res.executionId);
  } catch (err: any) {
    if (Array.isArray(err?.details)) applyIssues(err.details);
    execution.value = null;
    runError.value = err?.message ?? String(err);
    toastError(err);
  }
}

async function runPublished() {
  if (!wf.value) return;
  clearRunState();
  showExecPanel.value = true;
  showVersions.value = false;
  try {
    const res = await api<{ executionId: string }>(`/workflows/${wf.value.workflowId}/run`, { method: 'POST', body: { mode: 'published' } });
    execution.value = { executionId: res.executionId, status: 'queued', duration: null, errorSummary: null } as Execution;
    follow(res.executionId);
  } catch (err: any) {
    execution.value = null;
    runError.value = err?.message ?? String(err);
    toastError(err);
  }
}

async function cancelRun() {
  if (!execution.value) return;
  try {
    await api(`/executions/${execution.value.executionId}/cancel`, { method: 'POST' });
  } catch (err) {
    toastError(err);
  }
}

/* ---------------- keyboard & leave guards ---------------- */

function onKey(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey;
  const typing = (e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]');
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  } else if (!typing && mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (!typing && mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
  } else if (!typing && mod && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    duplicateSelected();
  } else if (!typing && !mod && !e.altKey) {
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') setTool('select');
    else if (e.shiftKey && k === 'a') autoArrange();
    else if (e.shiftKey && (e.key === '1' || e.key === '!')) fitToScreen();
    else if (e.shiftKey) return;
    else if (k === 'v') setTool('select');
    else if (k === 'h') setTool('pan');
    else if (k === 'b') setTool('box');
    else if (k === 'l') setTool('connect');
    else if (k === 'n' && canEdit.value) {
      e.preventDefault();
      focusAdd();
    }
  }
}
const beforeUnload = (e: BeforeUnloadEvent) => {
  if (dirty.value) e.preventDefault();
};
onBeforeRouteLeave(() => !dirty.value || confirm('You have unsaved changes. Leave without saving?'));
onMounted(() => {
  load();
  window.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', beforeUnload);
});
onBeforeUnmount(() => {
  stopStream?.();
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('beforeunload', beforeUnload);
});

const nodeName = (id: string) => (findNode(id)?.data as WbNodeData | undefined)?.name ?? id;
const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast('Copied', 'success', 1500));
</script>

<template>
  <div class="h-full flex flex-col bg-canvas">
    <!-- Top bar -->
    <header class="h-14 shrink-0 flex items-center gap-3 px-3 border-b border-line bg-surface">
      <button class="btn-ghost btn-icon" aria-label="Back to workflows" @click="router.push('/workflows')"><ArrowLeft class="size-4" /></button>
      <div v-if="wf" class="min-w-0 flex items-center gap-2.5">
        <input
          :value="wf.name"
          class="bg-transparent text-[14px] font-semibold outline-none min-w-[120px] max-w-[320px] border-b border-transparent focus:border-brand"
          :readonly="!canEdit"
          aria-label="Workflow name"
          @change="rename(($event.target as HTMLInputElement).value)"
        />
        <StatusBadge :status="wf.status" />
        <span class="text-[12px] text-subtle hidden md:inline">
          {{ wf.publishedVersion ? `Published v${wf.publishedVersion}` : 'Not published' }} ·
          <template v-if="saving">Saving…</template>
          <template v-else-if="dirty"><span class="text-warn">Unsaved changes</span></template>
          <template v-else>Draft saved {{ timeAgo(savedAt) }}</template>
        </span>
      </div>

      <div class="ml-auto flex items-center gap-1.5">
        <div class="relative" v-if="issues.length">
          <button class="btn-ghost h-8 text-[12px]" :class="errorCount ? 'text-warn' : 'text-muted'" @click="showIssues = !showIssues">
            <AlertTriangle class="size-4" />{{ errorCount }} issue{{ errorCount === 1 ? '' : 's' }}
          </button>
          <div v-if="showIssues" class="absolute right-0 top-10 z-30 card shadow-[var(--shadow-pop)] w-[360px] max-h-[320px] overflow-auto p-2 text-[12px]">
            <button
              v-for="(i, k) in issues"
              :key="k"
              class="w-full text-left flex gap-2 p-2 rounded hover:bg-surface-2"
              @click="i.nodeId && (selectedId = i.nodeId), (showIssues = false)"
            >
              <AlertTriangle class="size-3.5 shrink-0 mt-0.5" :class="i.severity === 'error' ? 'text-bad' : 'text-warn'" />
              <span>{{ i.message }}</span>
            </button>
          </div>
        </div>
        <button v-if="canEdit" class="btn-ghost btn-icon" title="Workflow settings" @click="openSettings"><Settings2 class="size-4" /></button>
        <button class="btn-ghost btn-icon" title="Export as .json (saves first)" @click="exportFile"><Download class="size-4" /></button>
        <button class="btn-ghost h-8" title="Versions" @click="openVersions"><History class="size-4" /><span class="hidden lg:inline">Versions</span></button>
        <button v-if="canEdit" class="btn-secondary" :disabled="saving || !dirty" title="Save draft (Ctrl+S)" @click="save()"><Save class="size-4" />Save</button>
        <button v-if="canEdit" class="btn-secondary" :disabled="running" title="Run the draft as a test" @click="run()">
          <Loader2 v-if="running" class="size-4 animate-spin" /><Play v-else class="size-4" />Test run
        </button>
        <template v-if="wf?.permissions.publish">
          <button class="btn-primary" :disabled="saving" @click="publish"><Rocket class="size-4" />Publish</button>
          <label class="flex items-center gap-2 pl-2 text-[12px] text-muted cursor-pointer" :class="{ 'opacity-50 pointer-events-none': !wf?.publishedVersion }" :title="wf?.publishedVersion ? '' : 'Publish first'">
            <button
              role="switch"
              :aria-checked="wf?.status === 'active'"
              class="relative w-9 h-5 rounded-full transition-colors"
              :class="wf?.status === 'active' ? 'bg-brand' : 'bg-line-strong'"
              @click="toggleActive"
            >
              <span class="absolute top-0.5 size-4 rounded-full bg-white shadow transition-all" :class="wf?.status === 'active' ? 'left-[18px]' : 'left-0.5'" />
            </button>
            Active
          </label>
        </template>
      </div>
    </header>

    <div v-if="loadError" class="flex-1 grid place-items-center text-[13px] text-bad">{{ loadError }}</div>

    <div v-else class="flex-1 min-h-0 flex">
      <NodePalette v-if="canEdit" ref="palette" @add="addNode($event)" @add-step="addTeamStep($event)" />

      <div class="flex-1 min-w-0 flex flex-col">
        <div class="flex-1 min-h-0 relative" :class="`wb-canvas-${tool}`" @drop.prevent="onDrop" @dragover.prevent>
          <VueFlow
            :id="flowId"
            :default-edge-options="edgeStyle"
            :nodes-draggable="canEdit && tool !== 'pan'"
            :elements-selectable="tool !== 'pan'"
            :pan-on-drag="tool !== 'box'"
            :selection-key-code="tool === 'box' ? true : 'Shift'"
            :nodes-connectable="canEdit"
            :edges-updatable="false"
            :delete-key-code="canEdit ? ['Backspace', 'Delete'] : null"
            :is-valid-connection="isValidConnection"
            :min-zoom="0.2"
            :max-zoom="2"
            :snap-to-grid="true"
            :snap-grid="[10, 10]"
            :default-viewport="{ x: 80, y: 80, zoom: 1 }"
            class="h-full"
            @node-click="({ node }) => onNodeClick(node.id)"
            @pane-click="onPaneClick"
            @node-drag-stop="commit"
            @nodes-change="onNodesChange"
            @edges-change="onEdgesChange"
          >
            <template #node-wb="props">
              <WorkflowNode v-bind="props" :class="{ 'wb-connect-source': connectFrom?.nodeId === props.id }" />
            </template>
            <Background pattern-color="var(--wb-grid)" :gap="20" :size="1.2" />
            <Controls :show-interactive="false" position="bottom-left" />
            <MiniMap pannable zoomable position="bottom-right" :node-color="'var(--wb-line-strong)'" mask-color="rgb(0 0 0 / 0.05)" />
          </VueFlow>

          <div v-if="wf && !nodes.length" class="absolute inset-0 grid place-items-center pointer-events-none">
            <div class="text-center">
              <p class="section-title">Start with a trigger</p>
              <p class="text-[13px] text-muted mt-1">Drag a trigger (e.g. <b>Schedule Trigger</b>) from the left onto the canvas — or click <b>Guide</b> (top right) for help.</p>
            </div>
          </div>
          <!-- Canvas toolbar -->
          <div v-if="wf" class="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-2">
            <div role="toolbar" aria-label="Canvas tools" class="flex items-center gap-0.5 p-1 card shadow-[var(--shadow-pop)]">
              <button class="wb-tool" :aria-pressed="tool === 'select'" title="Select (V)" data-no-loading @click="setTool('select')"><MousePointer2 class="size-4" /></button>
              <button class="wb-tool" :aria-pressed="tool === 'pan'" title="Pan — drag to move around (H)" data-no-loading @click="setTool('pan')"><Hand class="size-4" /></button>
              <template v-if="canEdit">
                <button class="wb-tool" :aria-pressed="tool === 'box'" title="Box select — drag to select several (B)" data-no-loading @click="setTool('box')"><SquareDashedMousePointer class="size-4" /></button>
                <button class="wb-tool" :aria-pressed="tool === 'connect'" title="Draw line — click two nodes to connect them (L)" data-no-loading @click="setTool('connect')"><Spline class="size-4" /></button>
                <div class="w-px h-5 bg-line mx-1" />
                <button class="wb-tool" title="Add node (N)" data-no-loading @click="focusAdd"><Plus class="size-4" /></button>
                <button class="wb-tool" title="Duplicate selected (Ctrl+D)" data-no-loading @click="duplicateSelected"><CopyPlus class="size-4" /></button>
                <button class="wb-tool wb-tool-danger" title="Delete selected (Delete)" data-no-loading @click="deleteSelected"><Trash2 class="size-4" /></button>
                <div class="w-px h-5 bg-line mx-1" />
                <button class="wb-tool" title="Undo (Ctrl+Z)" :disabled="!past.length" data-no-loading @click="undo"><Undo2 class="size-4" /></button>
                <button class="wb-tool" title="Redo (Ctrl+Shift+Z)" :disabled="!future.length" data-no-loading @click="redo"><Redo2 class="size-4" /></button>
                <div class="w-px h-5 bg-line mx-1" />
                <button class="wb-tool" title="Auto-arrange (Shift+A)" :disabled="!nodes.length" data-no-loading @click="autoArrange"><Network class="size-4 -rotate-90" /></button>
              </template>
              <button class="wb-tool" title="Fit to screen (Shift+1)" :disabled="!nodes.length" data-no-loading @click="fitToScreen"><Maximize class="size-4" /></button>
            </div>
            <div v-if="toolHint" class="chip h-7 px-3 text-[12px] bg-surface shadow-[var(--shadow-card)] animate-pop">
              {{ toolHint }}
              <template v-if="connectFrom && !connectFrom.handle">
                <button v-for="o in connectFrom.outputs" :key="o.id" class="btn-secondary h-5 px-2 text-[11px] ml-1" data-no-loading @click="connectFrom.handle = o.id">{{ o.label ?? o.id }}</button>
              </template>
              <button class="ml-1 text-subtle hover:text-ink" aria-label="Back to select (Esc)" title="Back to select (Esc)" data-no-loading @click="setTool('select')"><X class="size-3.5" /></button>
            </div>
          </div>
          <!-- Guide: top-right corner of the canvas -->
          <div class="absolute top-3 right-3 z-10 shadow-sm rounded-full"><GuideButton guide="editor" /></div>
          <div v-if="wf && !canEdit" class="absolute top-16 left-1/2 -translate-x-1/2 chip h-7 px-3 text-[12px]">View only — you can run this workflow but not edit it</div>
          <button v-if="!showExecPanel && execution" class="absolute bottom-3 left-1/2 -translate-x-1/2 btn-secondary shadow-[var(--shadow-pop)]" @click="showExecPanel = true">
            <StatusBadge :status="execution.status" />Show execution
          </button>
        </div>

        <ExecutionPanel
          v-if="showExecPanel"
          :execution="execution"
          :steps="steps"
          :selected-node-id="selectedId"
          :error="runError"
          @select="selectedId = $event"
          @close="showExecPanel = false"
          @cancel="cancelRun"
        />
      </div>

      <NodeSettingsPanel
        v-if="selectedNode"
        :node-id="selectedNode.id"
        :data="selectedNode.data"
        :step="selectedStep"
        :readonly="!canEdit"
        :published="!!wf?.publishedVersion"
        :webhook="webhookUrls[selectedNode.id] ?? null"
        :busy="running"
        @update="updateSelected"
        @close="selectedId = null"
        @delete="deleteSelected"
        @duplicate="duplicateSelected"
        @test="run(selectedNode.id)"
        @rotate-webhook="rotateWebhook"
      />
    </div>

    <!-- Versions -->
    <Modal v-if="showVersions" title="Versions" width="640px" @close="showVersions = false">
      <p class="text-[13px] text-muted mb-3">
        Each publish freezes the draft into an immutable version. Running executions always use the version they started with.
      </p>
      <p v-if="!versions.length" class="text-[13px] text-subtle">Nothing published yet.</p>
      <ul v-else class="divide-y divide-line border border-line rounded-md">
        <li v-for="v in versions" :key="v.versionId" class="flex items-center gap-3 px-3 py-2.5">
          <span class="chip">v{{ v.versionNumber }}</span>
          <div class="flex-1 min-w-0 text-[13px]">
            <div>{{ formatDate(v.publishedAt) }}</div>
            <div class="text-[11px] text-subtle">{{ v.nodeCount }} nodes</div>
          </div>
          <span v-if="v.versionNumber === wf?.publishedVersion" class="text-[11px] text-ok font-medium inline-flex items-center gap-1"><Check class="size-3" />Live</span>
          <button v-if="v.versionNumber === wf?.publishedVersion && wf?.permissions.run" class="btn-secondary h-7 text-[12px]" @click="runPublished"><Play class="size-3.5" />Run</button>
          <button class="btn-ghost h-7 text-[12px]" title="What changed in this version" @click="compareWithPrevious(v.versionNumber)">What changed?</button>
          <button v-if="canEdit" class="btn-ghost h-7 text-[12px]" @click="restoreVersion(v.versionNumber)">Load into draft</button>
        </li>
      </ul>
      <template v-if="wf?.publishedVersion" #footer>
        <button class="btn-secondary" @click="compareDraftWithLive"><GitCompare class="size-4" />Compare my draft with the live version</button>
      </template>
    </Modal>

    <Modal v-if="comparing" title="What changed" width="620px" @close="comparing = null">
      <VersionCompare :before="comparing.before" :after="comparing.after" :before-label="comparing.beforeLabel" :after-label="comparing.afterLabel" />
      <template #footer>
        <button class="btn-secondary" @click="comparing = null">Close</button>
      </template>
    </Modal>

    <!-- Workflow settings -->
    <Modal v-if="showSettings" title="Workflow settings" @close="showSettings = false">
      <div class="space-y-4">
        <div>
          <label class="label">Timeout (minutes)</label>
          <input v-model="settingsForm.timeoutMin" type="number" min="1" class="input" placeholder="Server default" />
          <p class="text-[11px] text-subtle mt-1">The run is stopped and marked failed after this long. Cannot exceed the server maximum. Keep it longer than any Wait node.</p>
        </div>
        <label class="flex items-center gap-2 text-[13px]"><input v-model="settingsForm.retryOn" type="checkbox" class="accent-[var(--wb-brand)]" />Retry temporary failures for every node that allows it</label>
        <div v-if="settingsForm.retryOn" class="grid grid-cols-2 gap-3 pl-6">
          <div><label class="label">Max attempts</label><input v-model="settingsForm.maxAttempts" type="number" min="1" max="10" class="input" /></div>
          <div><label class="label">First delay (ms)</label><input v-model="settingsForm.backoffMs" type="number" min="0" class="input" /></div>
          <p class="col-span-2 text-[11px] text-subtle">Applies to nodes that are safe to repeat (HTTP Request, Firebase Read/Update/Delete, Gmail Read). A node’s own retry setting wins. Emails and creates are never retried automatically.</p>
        </div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="showSettings = false">Cancel</button>
        <button class="btn-primary" @click="applySettings">Apply</button>
      </template>
    </Modal>

    <!-- Webhook URL (also shown in the Webhook step) -->
    <Modal v-if="issued" title="Webhook endpoint ready" width="600px" @close="issued = null">
      <div class="rounded-md bg-warn-soft text-warn text-[12px] p-2.5 mb-4 flex gap-2">
        <AlertTriangle class="size-4 shrink-0" />You can see and copy these again any time: click the Webhook step in this workflow.
      </div>
      <div v-for="h in issued" :key="h.webhookId" class="space-y-3">
        <div>
          <label class="label">URL ({{ nodeName(h.nodeId) }})</label>
          <div class="flex gap-1.5"><input class="input font-mono text-[12px]" readonly :value="h.url" /><button class="btn-secondary btn-icon" aria-label="Copy URL" @click="copy(h.url)"><Copy class="size-4" /></button></div>
        </div>
        <div>
          <label class="label">Signing secret (HMAC-SHA256)</label>
          <div class="flex gap-1.5"><input class="input font-mono text-[12px]" readonly :value="h.signingSecret" /><button class="btn-secondary btn-icon" aria-label="Copy secret" @click="copy(h.signingSecret)"><Copy class="size-4" /></button></div>
          <p class="text-[11px] text-subtle mt-1">Used only when “Require HMAC signature” is on. Header: <code>X-Widebed-Signature: sha256=&lt;hex&gt;</code></p>
        </div>
      </div>
      <p class="text-[12px] text-muted mt-4">The workflow must be <b>Active</b> for the URL to accept calls.</p>
      <template #footer><button class="btn-primary" @click="issued = null"><X class="size-4" />Done</button></template>
    </Modal>
  </div>
</template>
