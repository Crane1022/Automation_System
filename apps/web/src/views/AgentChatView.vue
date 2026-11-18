<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ArrowLeft,
  Brain,
  Check,
  CircleAlert,
  ClipboardCopy,
  FileDown,
  FileText,
  Paperclip,
  Loader2,
  Monitor,
  PanelRight,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Send,
  ShieldQuestion,
  Square,
  Trash2,
  X,
} from '@lucide/vue';
import type { AgentSummary, AssistantChat, AssistantMemory, AssistantMessage, AssistantStatus } from '@widebed/shared';
import Modal from '@/components/ui/Modal.vue';
import AgentAvatar from '@/components/ai/AgentAvatar.vue';
import RiskBadge from '@/components/ai/RiskBadge.vue';
import ChatPhoto from '@/components/ai/ChatPhoto.vue';
import { isPhoto, shrinkPhoto } from '@/lib/photos';
import GuideButton from '@/components/ui/GuideButton.vue';
import { READABLE_FILES, api, apiBlob, apiUpload, streamEvents } from '@/lib/api';
import { downloadBlob } from '@/lib/download';
import { timeAgo } from '@/lib/format';
import { renderMarkdown } from '@/lib/markdown';
import { toast, toastError } from '@/lib/toast';

/**
 * One AI employee's workspace: its chats on the left, the conversation in the middle,
 * what it can do on the right. Answers type out live (server-sent events from the API).
 */
const route = useRoute();
const router = useRouter();
const agentId = computed(() => String(route.params.agentId));
const chatId = computed(() => (typeof route.params.chatId === 'string' ? route.params.chatId : null));
const base = computed(() => `/ai-staff/${agentId.value}/chat`);

const agent = ref<AgentSummary | null>(null);
const status = ref<AssistantStatus | null>(null);
const chats = ref<AssistantChat[]>([]);
const chat = ref<AssistantChat | null>(null);
const messages = ref<AssistantMessage[]>([]);
const live = ref<Record<string, string>>({});
const screen = ref<{ at: string; url: string } | null>(null);
const screenUrl = ref<string | null>(null);
const text = ref('');
const sending = ref(false);
const listEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);
const chatQ = ref('');
const showSide = ref(true);
const listError = ref<string | null>(null);
const notFound = ref(false);

const busy = computed(() => chat.value?.status === 'running');
const last = computed(() => messages.value[messages.value.length - 1]);
const ready = computed(() => !!agent.value && !agent.value.problem && agent.value.status === 'active');
const shownChats = computed(() => {
  const s = chatQ.value.trim().toLowerCase();
  return s ? chats.value.filter((c) => c.title.toLowerCase().includes(s)) : chats.value;
});

/* ------------------------------------------------------------------ loading */

async function loadAgent() {
  try {
    agent.value = (await api<{ summary: AgentSummary }>(`/agents/${agentId.value}`)).summary;
    notFound.value = false;
  } catch {
    notFound.value = true;
  }
}
async function loadChats(quiet = false) {
  try {
    chats.value = (await api<{ items: AssistantChat[] }>('/assistant/chats', { query: { agentId: agentId.value }, quiet })).items;
    listError.value = null;
  } catch (err) {
    listError.value = (err as Error).message;
  }
}
async function loadChat(scroll = false, quiet = false) {
  if (!chatId.value) {
    chat.value = null;
    messages.value = [];
    screen.value = null;
    return;
  }
  const res = await api<{ chat: AssistantChat; messages: AssistantMessage[]; screen: { at: string; url: string } | null }>(`/assistant/chats/${chatId.value}`, { quiet });
  const grew = res.messages.length !== messages.value.length || JSON.stringify(res.messages[res.messages.length - 1]) !== JSON.stringify(last.value);
  chat.value = res.chat;
  messages.value = res.messages;
  // Saved text replaces the live text once the answer is finished.
  for (const m of res.messages) if (m.status !== 'running') delete live.value[m.messageId];
  if (res.screen && res.screen.at !== screen.value?.at) {
    screen.value = res.screen;
    loadScreen();
  } else if (!res.screen) screen.value = null;
  if (scroll || grew) scrollDown();
}
async function loadScreen() {
  if (!chatId.value) return;
  try {
    const blob = await apiBlob(`/assistant/chats/${chatId.value}/screen`, { quiet: true });
    if (screenUrl.value) URL.revokeObjectURL(screenUrl.value);
    screenUrl.value = URL.createObjectURL(blob);
  } catch {
    /* no screenshot yet */
  }
}
function nearBottom() {
  const el = listEl.value;
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 140;
}
function scrollDown(force = true) {
  if (!force && !nearBottom()) return;
  nextTick(() => listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: 'smooth' }));
}

/* --------------------------------------------------------------- live stream */

let stopStream: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function refreshSoon() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    loadChat(false, true)
      .then(() => scrollDown(false))
      .catch(() => undefined);
  }, 150);
}
function follow() {
  stopStream?.();
  stopStream = null;
  if (!chatId.value) return;
  const id = chatId.value;
  stopStream = streamEvents(`/assistant/chats/${id}/stream`, (type, data) => {
    if (id !== chatId.value) return;
    if (type === 'text') {
      live.value[data.messageId] = data.text;
      scrollDown(false);
    } else if (type === 'changed') refreshSoon();
  });
}
// Safety net: if the live stream drops, still refresh while it works.
let poll: ReturnType<typeof setInterval> | null = null;
watch(busy, (b, was) => {
  if (b && !poll) poll = setInterval(() => loadChat(false, true).catch(() => undefined), 3000);
  if (!b && poll) {
    clearInterval(poll);
    poll = null;
  }
  if (was && !b) {
    loadChats(true);
    loadAgent();
  }
});

watch(chatId, async () => {
  live.value = {};
  follow();
  await loadChat(true).catch(toastError);
  nextTick(() => inputEl.value?.focus());
});
watch(agentId, async () => {
  await Promise.all([loadAgent(), loadChats(true)]);
});

onMounted(async () => {
  showSide.value = window.innerWidth >= 1280;
  try {
    await Promise.all([loadAgent(), loadChats(true), api<AssistantStatus>('/assistant/status', { quiet: true }).then((s) => (status.value = s))]);
    follow();
    await loadChat(true);
  } catch (err) {
    toastError(err);
  }
  nextTick(() => inputEl.value?.focus());
});
onBeforeUnmount(() => {
  stopStream?.();
  if (poll) clearInterval(poll);
  if (screenUrl.value) URL.revokeObjectURL(screenUrl.value);
});

/* ------------------------------------------------------------------ actions */

/* Files attached to the next message: only their text is read and sent (files are not kept). */
interface Attached { key: string; name: string; kind: string; text: string; chars: number; truncated: boolean; reading: boolean }
const attached = ref<Attached[]>([]);
const fileEl = ref<HTMLInputElement | null>(null);
const reading = computed(() => attached.value.some((a) => a.reading) || photos.value.some((p) => p.reading));
/* Photos for the next message: shrunk in the browser, uploaded into the chat when sending. */
interface Photo { key: string; name: string; blob: Blob | null; preview: string | null; reading: boolean }
const photos = ref<Photo[]>([]);
async function addPhoto(f: File) {
  if (photos.value.length >= 3) return toast('Up to 3 photos per message.');
  const item: Photo = { key: `${f.name}-${Date.now()}-${Math.random()}`, name: f.name, blob: null, preview: null, reading: true };
  photos.value.push(item);
  try {
    const { blob, name } = await shrinkPhoto(f);
    Object.assign(photos.value.find((p) => p.key === item.key) ?? {}, { blob, name, preview: URL.createObjectURL(blob), reading: false });
  } catch (err) {
    photos.value = photos.value.filter((p) => p.key !== item.key);
    toast((err as Error).message, 'error');
  }
}
function removePhoto(key: string) {
  const p = photos.value.find((x) => x.key === key);
  if (p?.preview) URL.revokeObjectURL(p.preview);
  photos.value = photos.value.filter((x) => x.key !== key);
}
function onPaste(e: ClipboardEvent) {
  const imgs = [...(e.clipboardData?.files ?? [])].filter(isPhoto);
  if (!imgs.length) return;
  e.preventDefault();
  imgs.forEach(addPhoto);
}
async function addFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  for (const f of files) {
    if (isPhoto(f)) {
      void addPhoto(f);
      continue;
    }
    if (attached.value.length >= 3) {
      toast('Up to 3 files per message.');
      break;
    }
    if (f.size > 10 * 1024 * 1024) {
      toast(`${f.name} is larger than 10 MB.`);
      continue;
    }
    const item: Attached = { key: `${f.name}-${Date.now()}`, name: f.name, kind: '', text: '', chars: 0, truncated: false, reading: true };
    attached.value.push(item);
    try {
      const r = await apiUpload<{ kind: string; text: string; chars: number; truncated: boolean }>('/assistant/extract', f, { name: f.name });
      Object.assign(attached.value.find((a) => a.key === item.key) ?? {}, { kind: r.kind, text: r.text, chars: r.chars, truncated: r.truncated, reading: false });
    } catch (err) {
      attached.value = attached.value.filter((a) => a.key !== item.key);
      toastError(err);
    }
  }
}
const removeFile = (key: string) => (attached.value = attached.value.filter((a) => a.key !== key));
const kb = (chars: number) => (chars >= 1000 ? `${Math.round(chars / 1000)}k characters` : `${chars} characters`);

async function send(prefill?: string) {
  const t = (prefill ?? text.value).trim();
  const files = prefill ? [] : attached.value.filter((a) => !a.reading);
  const pics = prefill ? [] : photos.value.filter((p) => p.blob);
  if ((!t && !files.length && !pics.length) || sending.value || busy.value || reading.value) return;
  sending.value = true;
  try {
    let id = chatId.value;
    if (!id) {
      const c = await api<AssistantChat>('/assistant/chats', { method: 'POST', body: { agentId: agentId.value } });
      id = c.chatId;
      chats.value.unshift({ ...c, title: (t || files[0]?.name || pics[0]?.name || 'Photo').slice(0, 60), status: 'running' });
      await router.push(`${base.value}/${id}`);
    }
    // Photos go into the chat first; the message then points to them.
    const uploaded: { imageId: string; name: string; width: number; height: number }[] = [];
    for (const p of pics) uploaded.push(await apiUpload(`/assistant/chats/${id}/images`, p.blob!, { name: p.name }));
    text.value = '';
    attached.value = [];
    photos.value = [];
    autoGrow();
    // Show the question straight away; the server copy replaces it.
    const now = new Date().toISOString();
    messages.value.push({ messageId: `local-${now}`, chatId: id, role: 'user', text: t, status: 'done', steps: [], attachments: files.map((f) => ({ name: f.name, kind: f.kind, chars: f.chars })), images: uploaded, createdAt: now, updatedAt: now });
    scrollDown();
    await api(`/assistant/chats/${id}/messages`, { method: 'POST', body: { text: t, attachments: files.map((f) => ({ name: f.name, kind: f.kind, text: f.text })), imageIds: uploaded.map((u) => u.imageId) } });
    pics.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
    await loadChat(true);
    loadChats(true);
  } catch (err) {
    text.value = t;
    if (files.length && !attached.value.length) attached.value = files;
    if (pics.length && !photos.value.length) photos.value = pics;
    messages.value = messages.value.filter((m) => !m.messageId.startsWith('local-'));
    toastError(err);
  } finally {
    sending.value = false;
  }
}
async function regenerate() {
  if (!chatId.value) return;
  try {
    await api(`/assistant/chats/${chatId.value}/regenerate`, { method: 'POST' });
    await loadChat(true);
  } catch (err) {
    toastError(err);
  }
}
const confirmWord = ref('');
async function decide(approve: boolean) {
  try {
    await api(`/assistant/chats/${chatId.value}/decision`, { method: 'POST', body: { approve, confirmWord: confirmWord.value || undefined } });
    confirmWord.value = '';
    await loadChat(true);
  } catch (err) {
    toastError(err);
  }
}
async function stop() {
  await api(`/assistant/chats/${chatId.value}/stop`, { method: 'POST' }).catch(toastError);
}
async function removeChat(c: AssistantChat) {
  if (!confirm(`Delete the chat “${c.title}”? This can’t be undone.`)) return;
  try {
    await api(`/assistant/chats/${c.chatId}`, { method: 'DELETE' });
    chats.value = chats.value.filter((x) => x.chatId !== c.chatId);
    if (c.chatId === chatId.value) router.push(base.value);
  } catch (err) {
    toastError(err);
  }
}
async function copy(t: string) {
  try {
    await navigator.clipboard.writeText(t);
    toast('Copied', 'success', 1200);
  } catch {
    toast('Your browser blocked copying', 'error');
  }
}
/** "Copy" buttons inside code blocks of answers. */
function onAnswerClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest('[data-copy]');
  const code = btn?.parentElement?.querySelector('code');
  if (code) copy(code.textContent ?? '');
}
async function download(f: { fileId: string; name: string }) {
  try {
    downloadBlob(await apiBlob(`/assistant/files/${f.fileId}`), f.name);
  } catch (err) {
    toastError(err);
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}
function autoGrow() {
  nextTick(() => {
    const el = inputEl.value;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  });
}

/* ------------------------------------------------------------------- memory */

const showMemory = ref(false);
const memories = ref<AssistantMemory[]>([]);
const newMemory = ref('');
async function openMemory() {
  showMemory.value = true;
  memories.value = (await api<{ items: AssistantMemory[] }>('/assistant/memories', { query: { agentId: agentId.value } })).items;
}
async function addMemory() {
  if (!newMemory.value.trim()) return;
  try {
    memories.value.push(await api<AssistantMemory>('/assistant/memories', { method: 'POST', body: { text: newMemory.value, agentId: agentId.value } }));
    newMemory.value = '';
  } catch (err) {
    toastError(err);
  }
}
const editingMem = ref<string | null>(null);
const memDraft = ref('');
async function saveMemory(m: AssistantMemory) {
  try {
    const saved = await api<AssistantMemory>(`/assistant/memories/${m.memoryId}`, { method: 'PATCH', body: { text: memDraft.value } });
    m.text = saved.text;
    editingMem.value = null;
  } catch (err) {
    toastError(err);
  }
}
async function forget(m: AssistantMemory) {
  await api(`/assistant/memories/${m.memoryId}`, { method: 'DELETE' }).catch(toastError);
  memories.value = memories.value.filter((x) => x.memoryId !== m.memoryId);
}

/* -------------------------------------------------------------------- views */

const canPms = computed(() => !!agent.value?.tools.pms && !!status.value?.canUsePms);
const canSites = computed(() => !!agent.value?.tools.browser && !!status.value?.websites.length);
const toolList = computed(() => {
  const a = agent.value;
  if (!a) return [];
  return [
    { name: 'PMS data', on: canPms.value, why: a.tools.pms ? 'Not connected for you' : 'Not part of its job' },
    { name: 'Run workflows', on: a.tools.workflows, why: 'Not part of its job' },
    { name: 'Saved websites', on: canSites.value, why: a.tools.browser ? 'Browser is off or no website saved' : 'Not part of its job' },
    { name: 'Memory', on: a.tools.memory, why: 'Switched off' },
    { name: 'Company Knowledge', on: a.tools.knowledge !== false, why: 'Switched off' },
  ];
});
const suggestions = computed(() => {
  const a = agent.value;
  if (!a) return [];
  const out: string[] = [];
  for (const r of a.responsibilities.slice(0, 3)) out.push(r.endsWith('?') ? r : `${r.replace(/\.$/, '')}`);
  if (!out.length) out.push('What can you help me with?');
  if (a.tools.memory) out.push('Remember that I prefer short answers in bullet points');
  return out.slice(0, 4);
});
const shownText = (m: AssistantMessage) => (m.status === 'running' ? live.value[m.messageId] ?? m.text : m.text);
const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const workingLabel = (m: AssistantMessage) => {
  const s = [...m.steps].reverse().find((x) => x.status === 'running');
  if (s) return s.detail ? `${s.label} — ${s.detail}` : s.label;
  return live.value[m.messageId] ? 'Writing the answer' : 'Thinking';
};
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- Agent not available -->
    <div v-if="notFound" class="p-8 max-w-[560px] mx-auto text-center">
      <CircleAlert class="size-8 text-warn mx-auto" />
      <p class="section-title mt-3">This AI employee isn’t available to you</p>
      <p class="text-[13px] text-muted mt-1">It may have been switched off, or it belongs to another department.</p>
      <RouterLink to="/ai-staff" class="btn-secondary mt-4 inline-flex"><ArrowLeft class="size-4" />Back to AI Staff</RouterLink>
    </div>

    <div v-else class="flex-1 min-h-0 grid" :class="showSide ? 'xl:grid-cols-[260px_minmax(0,1fr)_280px] lg:grid-cols-[260px_minmax(0,1fr)]' : 'lg:grid-cols-[260px_minmax(0,1fr)]'">
      <!-- ============ left: profile + chats ============ -->
      <aside class="hidden lg:flex flex-col border-r border-line bg-surface min-h-0">
        <div class="p-3 border-b border-line">
          <RouterLink to="/ai-staff" class="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink mb-2"><ArrowLeft class="size-3.5" />AI Staff</RouterLink>
          <div v-if="agent" class="flex items-center gap-2.5">
            <AgentAvatar :avatar="agent.avatar" :color="agent.color" :size="38" :working="busy" />
            <div class="min-w-0">
              <div class="font-semibold text-[14px] truncate">{{ agent.name }}</div>
              <div class="text-[12px] text-muted truncate">{{ agent.title }}</div>
            </div>
          </div>
          <div v-else class="skeleton h-10 rounded-md" />
          <button class="btn-primary w-full mt-3 h-9" :disabled="!ready" @click="router.push(base)"><Plus class="size-4" />New chat</button>
        </div>
        <div class="px-3 pt-3">
          <div class="relative">
            <Search class="size-3.5 text-subtle absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input v-model="chatQ" class="input h-8 pl-8 text-[12.5px]" placeholder="Search chats" />
          </div>
        </div>
        <div class="flex-1 overflow-y-auto p-2 relative">
          <div v-if="listError" class="text-[12px] text-bad p-3">
            Could not load your chats: {{ listError }}
            <button class="block text-brand mt-1" @click="loadChats()">Try again</button>
          </div>
          <p v-else-if="!shownChats.length" class="text-[12px] text-subtle p-3">{{ chatQ ? 'No chat matches.' : 'Your chats with this AI employee will appear here.' }}</p>
          <TransitionGroup name="list" tag="div" class="relative">
            <div v-for="c in shownChats" :key="c.chatId" class="group flex items-center rounded-md transition-colors" :class="c.chatId === chatId ? 'bg-brand-soft' : 'hover:bg-surface-2'">
              <RouterLink :to="`${base}/${c.chatId}`" class="flex-1 min-w-0 px-2.5 py-2">
                <div class="text-[13px] truncate" :class="c.chatId === chatId ? 'text-brand font-medium' : ''">{{ c.title }}</div>
                <div class="text-[11px] text-subtle flex items-center gap-1">
                  <span v-if="c.status === 'running'" class="size-1.5 rounded-full bg-ok animate-pulse" />
                  {{ c.status === 'running' ? 'Working…' : c.status === 'waiting' ? 'Waiting for you' : timeAgo(c.updatedAt) }}
                </div>
              </RouterLink>
              <button class="btn-ghost btn-icon size-7 opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label="Delete chat" @click="removeChat(c)"><Trash2 class="size-3.5" /></button>
            </div>
          </TransitionGroup>
        </div>
      </aside>

      <!-- ============ middle: conversation ============ -->
      <section class="flex flex-col min-h-0 min-w-0 bg-bg">
        <!-- header -->
        <header class="h-14 px-4 border-b border-line bg-surface flex items-center gap-3 shrink-0">
          <RouterLink to="/ai-staff" class="lg:hidden btn-ghost btn-icon size-8" aria-label="Back"><ArrowLeft class="size-4" /></RouterLink>
          <AgentAvatar v-if="agent" class="lg:hidden" :avatar="agent.avatar" :color="agent.color" :size="30" :working="busy" />
          <div class="min-w-0 flex-1">
            <div class="text-[14px] font-medium truncate">{{ chat?.title ?? (agent ? `New chat with ${agent.name}` : '') }}</div>
            <div class="text-[11.5px] truncate" :class="busy ? 'text-ok' : 'text-subtle'">
              <template v-if="busy && last">{{ workingLabel(last) }}…</template>
              <template v-else-if="agent">{{ agent.aiName ?? 'No AI chosen' }}</template>
            </div>
          </div>
          <button class="btn-ghost h-8 text-[12.5px] lg:hidden" @click="router.push(base)"><Plus class="size-4" />New</button>
          <button class="btn-ghost h-8 text-[12.5px]" @click="openMemory"><Brain class="size-4" /><span class="hidden sm:inline">Memory</span></button>
          <RouterLink v-if="agent?.canEdit" :to="`/ai-staff/${agentId}/edit`" class="btn-ghost h-8 text-[12.5px]"><Pencil class="size-4" /><span class="hidden sm:inline">Edit</span></RouterLink>
          <GuideButton class="hidden sm:inline-flex" />
          <button class="btn-ghost btn-icon size-8 hidden xl:inline-flex" :aria-label="showSide ? 'Hide details' : 'Show details'" @click="showSide = !showSide"><PanelRight class="size-4" /></button>
        </header>

        <div v-if="agent && (agent.problem || agent.status !== 'active')" class="mx-4 mt-3 card p-3 flex gap-2.5 items-start text-[13px] animate-in">
          <CircleAlert class="size-4 text-warn shrink-0 mt-0.5" />
          <div>
            <span class="font-medium">{{ agent.name }} can’t answer yet.</span>
            <span class="text-muted"> {{ agent.problem }}</span>
            <RouterLink v-if="status?.canManage" to="/ai-agents" class="text-brand ml-1">Open AI Settings →</RouterLink>
          </div>
        </div>

        <!-- messages -->
        <div ref="listEl" class="flex-1 overflow-y-auto" @click="onAnswerClick">
          <div class="max-w-[820px] mx-auto px-4 py-6 space-y-6">
            <!-- Welcome -->
            <div v-if="!messages.length && agent" class="text-center pt-[8vh] animate-in">
              <AgentAvatar :avatar="agent.avatar" :color="agent.color" :size="64" class="mx-auto" />
              <h1 class="text-[20px] font-semibold mt-4">Hi, I’m {{ agent.name }}</h1>
              <p class="text-[13.5px] text-muted mt-1 max-w-[460px] mx-auto">{{ agent.description || 'How can I help today?' }}</p>
              <div class="grid sm:grid-cols-2 gap-2 mt-6 max-w-[560px] mx-auto text-left">
                <button
                  v-for="(s, i) in suggestions"
                  :key="s"
                  class="card lift px-3.5 py-2.5 text-[13px] hover:border-brand disabled:opacity-50 animate-in"
                  :style="{ '--i': i + 1 }"
                  :disabled="!ready"
                  @click="send(s)"
                >
                  {{ s }}
                </button>
              </div>
            </div>

            <template v-for="m in messages" :key="m.messageId">
              <!-- question -->
              <div v-if="m.role === 'user'" class="flex justify-end animate-in">
                <div class="group max-w-[85%]">
                  <div v-if="m.images?.length && chatId" class="flex flex-wrap justify-end gap-1.5 mb-1">
                    <ChatPhoto v-for="p in m.images" :key="p.imageId" :chat-id="chatId" :image-id="p.imageId" :name="p.name" :width="p.width" :height="p.height" />
                  </div>
                  <div v-if="m.attachments?.length" class="flex flex-wrap justify-end gap-1.5 mb-1">
                    <span v-for="f in m.attachments" :key="f.name" class="chip h-7 bg-surface" :title="`Only the text was given to the AI (${kb(f.chars)}). The file was not kept.`"><FileText class="size-3.5 text-brand" />{{ f.name }}</span>
                  </div>
                  <div v-if="m.text" class="rounded-2xl rounded-br-md bg-brand text-white px-4 py-2.5 text-[13.5px] whitespace-pre-wrap break-words shadow-sm">{{ m.text }}</div>
                  <div class="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity mt-1">
                    <button class="btn-ghost h-6 px-1.5 text-[11.5px]" @click="copy(m.text)"><ClipboardCopy class="size-3" />Copy</button>
                  </div>
                </div>
              </div>

              <!-- answer -->
              <div v-else class="flex gap-3 animate-in">
                <AgentAvatar v-if="agent" :avatar="agent.avatar" :color="agent.color" :size="30" :working="m.status === 'running'" class="mt-0.5" />
                <div class="min-w-0 flex-1 group">
                  <!-- tool activity -->
                  <ul v-if="m.steps.length" class="mb-2 space-y-1 rounded-lg border border-line bg-surface px-3 py-2">
                    <li v-for="s in m.steps" :key="s.id" class="flex items-start gap-2 text-[12.5px] animate-in">
                      <Loader2 v-if="s.status === 'running'" class="size-3.5 mt-0.5 animate-spin text-brand shrink-0" />
                      <Check v-else-if="s.status === 'done'" class="size-3.5 mt-0.5 text-ok shrink-0" />
                      <X v-else class="size-3.5 mt-0.5 text-bad shrink-0" />
                      <span :class="s.status === 'error' ? 'text-bad' : s.status === 'running' ? 'text-ink' : 'text-muted'">{{ s.label }}<span v-if="s.detail" class="text-subtle"> — {{ s.detail }}</span></span>
                    </li>
                  </ul>

                  <div v-if="m.status === 'running' && !shownText(m)" class="flex items-center gap-2 text-[12.5px] text-muted py-1">
                    <span class="dots text-brand"><span /><span /><span /></span>{{ workingLabel(m) }}
                  </div>

                  <!-- the answer (markdown, typing live) -->
                  <div
                    v-if="shownText(m)"
                    class="md"
                    :class="[m.status === 'error' ? 'text-bad' : '', m.status === 'running' ? 'typing-caret' : '']"
                    v-html="renderMarkdown(shownText(m))"
                  />

                  <!-- approval -->
                  <div
                    v-if="m.status === 'waiting_approval' && m.pending"
                    class="animate-pop mt-3 rounded-xl border p-4"
                    :class="m.pending.level === 4 ? 'border-bad/50 bg-bad-soft' : 'border-warn bg-warn-soft'"
                  >
                    <div class="flex flex-wrap items-center gap-2 font-medium text-[13.5px]">
                      <ShieldQuestion class="size-4" :class="m.pending.level === 4 ? 'text-bad' : 'text-warn'" />{{ agent?.name }} needs {{ m.pending.level === 4 ? 'approval for a critical action' : 'your OK' }}
                      <RiskBadge v-if="m.pending.level" :level="m.pending.level" />
                    </div>
                    <p class="text-[13px] mt-1.5">{{ m.pending.details }}</p>
                    <p v-if="m.pending.expiresAt" class="text-[11.5px] text-subtle mt-1">Expires {{ new Date(m.pending.expiresAt).toLocaleString() }} — after that nothing is done.</p>
                    <div v-if="m.messageId === last?.messageId" class="mt-3">
                      <template v-if="m.pending.level === 4">
                        <p class="text-[12px] text-muted mb-2">Only an Admin or a named approver can approve this. If that’s you, type <b>APPROVE</b>. Otherwise it waits in the Approval Center.</p>
                        <input v-model="confirmWord" class="input h-8 max-w-[200px] mb-2" placeholder="APPROVE" autocomplete="off" />
                      </template>
                      <div class="flex flex-wrap items-center gap-2">
                        <button class="btn-primary h-8" :disabled="m.pending.level === 4 && confirmWord.trim().toUpperCase() !== 'APPROVE'" @click="decide(true)"><Check class="size-4" />Approve</button>
                        <button class="btn-secondary h-8" @click="decide(false)">Don’t do it</button>
                        <RouterLink v-if="m.pending.approvalId" :to="{ path: '/ai-approvals', query: { id: m.pending.approvalId } }" class="text-[12px] text-brand hover:underline ml-auto">Open in Approvals</RouterLink>
                      </div>
                    </div>
                  </div>
                  <p v-if="m.status === 'waiting_input' && m.messageId === last?.messageId" class="text-[12px] text-info mt-2">Type your answer below.</p>
                  <p v-if="m.status === 'stopped'" class="text-[12px] text-subtle mt-1">Stopped.</p>

                  <!-- files -->
                  <div v-if="m.files?.length" class="flex flex-wrap gap-2 mt-3">
                    <button v-for="f in m.files" :key="f.fileId" class="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px] hover:border-brand transition-colors" @click="download(f)">
                      <FileDown class="size-4 text-brand" />{{ f.name }}<span class="text-subtle">{{ fmtSize(f.size) }}</span>
                    </button>
                  </div>

                  <!-- actions -->
                  <div v-if="m.status !== 'running' && m.text" class="flex gap-1 mt-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <button class="btn-ghost h-7 px-2 text-[12px]" @click="copy(m.text)"><ClipboardCopy class="size-3.5" />Copy</button>
                    <button v-if="m.messageId === last?.messageId && !busy && ready" class="btn-ghost h-7 px-2 text-[12px]" @click="regenerate"><RotateCcw class="size-3.5" />Answer again</button>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- browser view -->
        <details v-if="screen && screenUrl" class="animate-in border-t border-line bg-surface px-4 py-2" :open="busy">
          <summary class="text-[12px] text-muted cursor-pointer flex items-center gap-1.5"><Monitor class="size-3.5" />What {{ agent?.name ?? 'the assistant' }}’s browser sees · {{ screen.url }}</summary>
          <img :src="screenUrl" alt="Screenshot of the AI employee’s browser" class="mt-2 rounded-md border border-line max-h-[300px] w-auto" />
        </details>

        <!-- input -->
        <div class="shrink-0 px-4 pb-4 pt-2">
          <div class="max-w-[820px] mx-auto">
            <TransitionGroup v-if="photos.length" name="list" tag="div" class="flex flex-wrap gap-2 mb-2">
              <div v-for="p in photos" :key="p.key" class="relative size-16 rounded-lg overflow-hidden border border-line bg-surface-2 shadow-sm">
                <img v-if="p.preview" :src="p.preview" :alt="p.name" class="size-full object-cover" />
                <span v-else class="size-full grid place-items-center"><Loader2 class="size-4 animate-spin text-info" /></span>
                <button class="absolute top-0.5 right-0.5 size-5 rounded-full bg-black/60 text-white grid place-items-center hover:bg-black/80" :aria-label="`Remove ${p.name}`" data-no-loading @click="removePhoto(p.key)"><X class="size-3" /></button>
              </div>
            </TransitionGroup>
            <TransitionGroup v-if="attached.length" name="list" tag="div" class="flex flex-wrap gap-1.5 mb-2">
              <span v-for="f in attached" :key="f.key" class="chip h-8 bg-surface pr-1" :title="f.truncated ? 'Long file: only the beginning will be read.' : ''">
                <Loader2 v-if="f.reading" class="size-3.5 animate-spin text-info" />
                <FileText v-else class="size-3.5 text-brand" />
                <span class="max-w-[200px] truncate">{{ f.name }}</span>
                <span class="text-subtle text-[11px]">{{ f.reading ? 'reading…' : kb(f.chars) + (f.truncated ? ' (beginning only)' : '') }}</span>
                <button class="btn-ghost btn-icon size-6" :aria-label="`Remove ${f.name}`" data-no-loading @click="removeFile(f.key)"><X class="size-3" /></button>
              </span>
            </TransitionGroup>
            <div class="rounded-2xl border border-line-strong bg-surface shadow-sm focus-within:border-brand focus-within:shadow-[0_0_0_3px_var(--color-brand-soft)] transition-[border-color,box-shadow] flex items-end gap-2 p-2">
              <input ref="fileEl" type="file" class="hidden" multiple :accept="`${READABLE_FILES},image/*`" @change="addFiles" />
              <button class="btn-ghost h-9 w-9 p-0 rounded-xl justify-center" aria-label="Attach a file" title="Attach a photo or a file (PDF, Word, Excel, text)" :disabled="!ready || busy" data-no-loading @click="fileEl?.click()"><Paperclip class="size-4" /></button>
              <textarea
                ref="inputEl"
                v-model="text"
                class="flex-1 resize-none bg-transparent outline-none text-[14px] leading-6 px-2 py-1.5 max-h-[200px]"
                rows="1"
                :placeholder="last?.status === 'waiting_input' ? 'Type your answer…' : agent ? `Message ${agent.name}…` : 'Message…'"
                :disabled="!ready || busy"
                @keydown="onKey"
                @paste="onPaste"
                @input="autoGrow"
              />
              <button v-if="busy" class="btn-secondary h-9 rounded-xl" data-no-loading @click="stop"><Square class="size-3.5 fill-current" />Stop</button>
              <button v-else class="btn-primary h-9 w-9 p-0 rounded-xl justify-center" aria-label="Send" :disabled="(!text.trim() && !attached.length && !photos.length) || sending || reading || !ready" @click="send()"><Send class="size-4" /></button>
            </div>
            <p class="text-[11px] text-subtle text-center mt-1.5">Enter to send · Shift+Enter for a new line · 📎 photos and files · AI can make mistakes — check important numbers.</p>
          </div>
        </div>
      </section>

      <!-- ============ right: about ============ -->
      <Transition name="page">
        <aside v-if="showSide && agent" class="hidden xl:block border-l border-line bg-surface overflow-y-auto p-4 space-y-5 text-[13px]">
          <div>
            <h3 class="text-[11.5px] font-medium text-subtle uppercase tracking-wide mb-2">Job</h3>
            <ul v-if="agent.responsibilities.length" class="space-y-1.5">
              <li v-for="r in agent.responsibilities" :key="r" class="flex gap-2"><Check class="size-3.5 mt-0.5 text-brand shrink-0" />{{ r }}</li>
            </ul>
            <p v-else class="text-subtle">{{ agent.description || 'No job description yet.' }}</p>
          </div>
          <div>
            <h3 class="text-[11.5px] font-medium text-subtle uppercase tracking-wide mb-2">Can use</h3>
            <ul class="space-y-1.5">
              <li v-for="t in toolList" :key="t.name" class="flex items-center gap-2" :title="t.on ? '' : t.why">
                <span class="size-1.5 rounded-full" :class="t.on ? 'bg-ok' : 'bg-line-strong'" />
                <span :class="t.on ? '' : 'text-subtle line-through'">{{ t.name }}</span>
              </li>
            </ul>
          </div>
          <div v-if="agent.expertise.length">
            <h3 class="text-[11.5px] font-medium text-subtle uppercase tracking-wide mb-2">Expertise</h3>
            <div class="flex flex-wrap gap-1"><span v-for="e in agent.expertise" :key="e" class="chip">{{ e }}</span></div>
          </div>
          <div>
            <h3 class="text-[11.5px] font-medium text-subtle uppercase tracking-wide mb-2">Memory</h3>
            <p class="text-muted">{{ agent.tools.memory ? 'Remembers what you tell it, separately from other AI staff.' : 'Memory is switched off.' }}</p>
            <button class="btn-secondary h-8 mt-2 w-full" @click="openMemory"><Brain class="size-4" />What {{ agent.name }} remembers</button>
          </div>
          <div>
            <h3 class="text-[11.5px] font-medium text-subtle uppercase tracking-wide mb-2">Background work</h3>
            <div class="grid gap-1.5">
              <RouterLink :to="{ path: '/ai-tasks', query: { agentId } }" class="btn-secondary h-8 justify-start">Tasks of {{ agent.name }}</RouterLink>
              <RouterLink v-if="agent.canEdit" to="/ai-schedules" class="btn-secondary h-8 justify-start">Schedules</RouterLink>
            </div>
          </div>
          <div class="text-[12px] text-subtle border-t border-line pt-3">
            {{ agent.aiName ?? 'No AI chosen' }}<br />
            <template v-if="agent.lastActiveAt">Last active {{ timeAgo(agent.lastActiveAt) }}</template>
          </div>
        </aside>
      </Transition>
    </div>

    <Modal v-if="showMemory" :title="`What ${agent?.name ?? 'it'} remembers about you`" width="560px" @close="showMemory = false">
      <p class="text-[12.5px] text-muted -mt-1 mb-3">Read at the start of every chat with {{ agent?.name }}. Only you can see this. Other AI staff have their own memory.</p>
      <TransitionGroup v-if="memories.length" name="list" tag="ul" class="space-y-1.5 mb-4 relative">
        <li v-for="m in memories" :key="m.memoryId" class="group flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-[13px]">
          <template v-if="editingMem === m.memoryId">
            <input v-model="memDraft" class="input h-7 flex-1" maxlength="300" @keydown.enter.prevent="saveMemory(m)" @keydown.esc="editingMem = null" />
            <button class="btn-ghost btn-icon h-7 w-7" aria-label="Save" @click="saveMemory(m)"><Check class="size-3.5 text-ok" /></button>
          </template>
          <template v-else>
            <span class="flex-1">{{ m.text }}</span>
            <button class="btn-ghost btn-icon h-6 w-6 opacity-0 group-hover:opacity-100" aria-label="Correct" @click="((editingMem = m.memoryId), (memDraft = m.text))"><Pencil class="size-3.5" /></button>
            <button class="btn-ghost btn-icon h-6 w-6" aria-label="Forget" @click="forget(m)"><X class="size-3.5" /></button>
          </template>
        </li>
      </TransitionGroup>
      <p v-else class="text-[13px] text-subtle mb-4">Nothing yet. Say “remember …” in a chat, or add something here.</p>
      <form class="flex gap-2" @submit.prevent="addMemory">
        <input v-model="newMemory" class="input" maxlength="300" placeholder="e.g. Unit A-12’s TNB account is 2200-1111" />
        <button class="btn-secondary" type="submit">Add</button>
      </form>
    </Modal>
  </div>
</template>
