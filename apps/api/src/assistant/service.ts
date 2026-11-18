import { EventEmitter } from 'node:events';
import {
  AI_SERVICE_INFO,
  DEFAULT_AGENT_ID,
  DEFAULT_ASSISTANT_SETTINGS,
  memorySecretProblem,
  type AiAgent,
  type AgentSummary,
  hasPermission,
  todayInfo,
  type AppUser,
  type AssistantChat,
  type AssistantMessage,
  type AssistantSettings,
  type AssistantStatus,
  type AssistantStep,
  type Credential,
} from '@widebed/shared';
import type { Repositories, StoredAssistantChat } from '../repositories/types.js';
import type { CredentialService } from '../services/credential-service.js';
import type { ExecutionService } from '../services/execution-service.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http-error.js';
import { newId, nowIso } from '../lib/ids.js';
import { runAgent, type AgentOutcome, type AgentStepEvent, type AgentTool, type TranscriptEntry } from './agent.js';
import { MAX_MEMORIES, agentMemories, memoryTools, pmsTools, workflowTools } from './tools.js';
import { AgentRegistry, identityText } from './agents.js';
import type { ApprovalService } from './approvals.js';
import type { ToolGate } from './agent.js';
import { browserTools, type BrowserSessions, type SavedFile } from './browser.js';
import { KnowledgeService, knowledgeTools } from '../services/knowledge.js';
import { CHAT_IMAGE_LIMITS, KNOWLEDGE_LIMITS, myDay, type ChatImage } from '@widebed/shared';
import { imageInfo } from '../services/image-info.js';

const SETTINGS_KEY = 'assistant';
const MAX_TEXT = 4000;

/** Text of a file the person attached to a message (the file itself is not kept). */
export interface AttachmentText {
  name: string;
  kind: string;
  text: string;
}

const ATTACH_START = '\n\n[Attached file “';
const PHOTO_REF = /\(photo (img_[A-Za-z0-9_-]+)\)/g;

/** The newest photo ids mentioned in the person's messages (newest first). */
export function photoIds(t: TranscriptEntry[], max: number = CHAT_IMAGE_LIMITS.aiSees): string[] {
  const out: string[] = [];
  for (let i = t.length - 1; i >= 0 && out.length < max; i--) {
    const e = t[i]!;
    if (e.role !== 'user') continue;
    const ids = [...e.text.matchAll(PHOTO_REF)].map((m) => m[1]!).reverse();
    for (const id of ids) if (out.length < max && !out.includes(id)) out.push(id);
  }
  return out;
}
/** The transcript lives in the chat document (max 1 MB): old attachment text is dropped first. */
export function packTranscript(t: TranscriptEntry[], max = 600_000): string {
  let json = JSON.stringify(t);
  if (json.length <= max) return json;
  const lastUser = t.map((e) => e.role).lastIndexOf('user');
  const out = t.map((e, i) => {
    if (e.role !== 'user' || i === lastUser || !e.text.includes(ATTACH_START)) return e;
    const [head, ...files] = e.text.split(ATTACH_START);
    return { ...e, text: head + files.map((f) => `${ATTACH_START}${f.slice(0, f.indexOf('”') + 1)} — its text was removed to save space]`).join('') };
  });
  json = JSON.stringify(out);
  if (json.length <= max) return json;
  // Still too big: shorten old tool results too.
  return JSON.stringify(out.map((e, i) => (e.role === 'tool' && i < out.length - 6 ? { ...e, result: e.result.slice(0, 1500) } : e)));
}

const STALE_MS = 5 * 60_000;

export interface AssistantDeps {
  repos: Repositories;
  credentials: CredentialService;
  executions: ExecutionService;
  browser: BrowserSessions | null;
  /** For tests: wait settings of run_workflow. */
  workflowWait?: { waitMs?: number; pollMs?: number };
}

/** What a scheduled AI Agent step may use (Stage 4). */
export interface HeadlessAgentRequest {
  goal: string;
  useWorkflows: boolean;
  usePms: boolean;
  websites: string[] | 'all';
  /** Lets run_workflow and risky clicks happen without a person (off by default). */
  allowActions: boolean;
  signal?: AbortSignal;
  /** Which AI employee does the work (default: the Widebed Assistant). */
  agentId?: string;
  /** Progress of each step (AI Staff tasks show these live). */
  onStep?: (e: AgentStepEvent) => void | Promise<void>;
  /** Token counts of each AI call. */
  onUsage?: (u: { inputTokens: number; outputTokens: number; model: string }) => void;
  /** Continue an earlier run (AI Staff tasks that waited for an approval). */
  transcript?: TranscriptEntry[];
  resume?: { tool: string; input: unknown; approved: boolean };
  /** Approval policy; with it, actions that need approval stop the run with `pending` instead of being refused. */
  gate?: ToolGate;
  onToolDone?: (tool: string, input: unknown, ok: boolean) => void | Promise<void>;
  /** Browser session id (default: a new one per run). */
  sessionId?: string;
  /** Delegated work: at most these tools (the manager's), and no further delegating. */
  toolLimit?: import('@widebed/shared').AgentTools | null;
  /** The background task this run belongs to (for a manager's delegations). */
  taskId?: string;
}

/** A headless run that stopped to wait for a person's approval. */
export interface HeadlessPending {
  tool: string;
  input: unknown;
  label: string;
  details: string;
  level: import('@widebed/shared').RiskLevel;
  target: string;
  say: string;
}

/** Live events for one chat (sent to the browser over SSE). */
export type ChatLiveEvent = { type: 'text'; messageId: string; text: string } | { type: 'changed' };

export class AssistantService {
  private running = new Map<string, AbortController>();
  /** chatId → agentId of chats working right now (for the "working" badge on AI Staff cards). */
  private runningAgent = new Map<string, { agentId: string; ownerId: string }>();
  private live = new EventEmitter();
  readonly agents: AgentRegistry;
  readonly knowledge: KnowledgeService;
  private approvals: ApprovalService | null = null;

  /** Connects the Approval Center (set up right after this service). */
  useApprovals(a: ApprovalService) {
    this.approvals = a;
    a.onDecision('chat', (ap, approved) => this.continueAfterDecision(ap, approved));
  }

  constructor(private d: AssistantDeps) {
    this.live.setMaxListeners(1000);
    this.agents = new AgentRegistry(d.repos);
    this.knowledge = new KnowledgeService(d.repos);
  }

  /** Follow one chat live (text while it is typed, and "something changed"). Returns unsubscribe. */
  async subscribe(user: AppUser, chatId: string, fn: (e: ChatLiveEvent) => void) {
    await this.ownChat(user, chatId);
    this.live.on(chatId, fn);
    return () => void this.live.off(chatId, fn);
  }
  private emit(chatId: string, e: ChatLiveEvent) {
    this.live.emit(chatId, e);
  }

  /* ------------------------------------------------------------- settings */

  async settings(): Promise<AssistantSettings> {
    return { ...DEFAULT_ASSISTANT_SETTINGS, ...((await this.d.repos.settings.get<AssistantSettings>(SETTINGS_KEY)) ?? {}) };
  }

  async saveSettings(user: AppUser, input: AssistantSettings) {
    if (!hasPermission(user, 'credential.manage')) throw forbidden('Only IT Admins and Super Admins set up the assistant');
    if (input.aiCredentialId) {
      const ai = await this.d.repos.credentials.get(input.aiCredentialId);
      if (!ai || ai.provider !== 'ai_provider') throw badRequest('Choose an AI service connection');
    } else if (input.enabled) {
      throw badRequest('Choose the AI service the assistant should use');
    }
    if (input.pmsCredentialId) {
      const pms = await this.d.repos.credentials.get(input.pmsCredentialId);
      if (!pms || pms.provider !== 'firebase_service_account') throw badRequest('Choose a Firebase project connection for PMS data');
      if (!pms.details.readOnly) throw badRequest(`For safety the assistant only uses read-only connections. Tick “Read-only” on “${pms.name}” first (Credentials → Access).`);
    }
    const value: AssistantSettings = { enabled: !!input.enabled, aiCredentialId: input.aiCredentialId || null, pmsCredentialId: input.pmsCredentialId || null, browserEnabled: !!input.browserEnabled };
    await this.d.repos.settings.set(SETTINGS_KEY, value);
    return value;
  }

  async status(user: AppUser): Promise<AssistantStatus> {
    const s = await this.settings();
    const creds = await this.d.credentials.listVisible(user);
    const ai = s.aiCredentialId ? await this.d.repos.credentials.get(s.aiCredentialId) : null;
    const pms = s.pmsCredentialId ? await this.d.repos.credentials.get(s.pmsCredentialId) : null;
    const usable = (c: Credential | null) => !!c && this.d.credentials.usableBy(c, user.department);
    let problem: string | null = null;
    if (!s.enabled) problem = 'The assistant is switched off. An IT Admin can switch it on in “Set up the assistant”.';
    else if (!ai) problem = 'No AI service is chosen for the assistant.';
    else if (!usable(ai)) problem = 'The assistant’s AI service is limited to another department.';
    else if (ai.status === 'error') problem = `The AI service connection needs attention: ${ai.lastTestResult ?? 'test it on the Credentials page'}`;
    return {
      enabled: s.enabled,
      ready: !problem,
      problem,
      aiName: ai ? `${ai.name}${ai.details.aiService ? ` · ${AI_SERVICE_INFO[ai.details.aiService].label}` : ''}` : null,
      pmsName: pms?.name ?? null,
      canUsePms: this.canUsePms(user, pms),
      browserEnabled: s.browserEnabled,
      websites: s.browserEnabled ? creds.filter((c) => c.provider === 'website_login' && this.d.credentials.usableBy(c, user.department)).map((c) => ({ credentialId: c.credentialId, name: c.name })) : [],
      canManage: hasPermission(user, 'credential.manage'),
      ...(hasPermission(user, 'credential.manage') ? { settings: s } : {}),
    };
  }

  /** Why this AI employee can't answer this person right now, or null. */
  async agentProblem(user: AppUser, a: AiAgent): Promise<string | null> {
    const s = await this.settings();
    if (!s.enabled) return 'AI staff are switched off. An IT Admin can switch them on in AI Settings.';
    if (a.status !== 'active') return `${a.name} is switched off.`;
    const id = a.aiCredentialId ?? s.aiCredentialId;
    if (!id) return 'No AI service is chosen. An admin can pick one in AI Settings or on this AI employee.';
    const ai = await this.d.repos.credentials.get(id);
    if (!ai) return 'The chosen AI service connection was deleted.';
    if (!this.d.credentials.usableBy(ai, user.department)) return 'This AI employee’s AI service is limited to another department.';
    if (ai.status === 'error') return `The AI service connection needs attention: ${ai.lastTestResult ?? 'test it on the Credentials page'}`;
    return null;
  }

  /** What a person sees about an AI employee. */
  async summarize(user: AppUser, list: AiAgent[]): Promise<AgentSummary[]> {
    const s = await this.settings();
    const creds = new Map((await this.d.repos.credentials.list(500)).map((c) => [c.credentialId, c]));
    const chats = await this.d.repos.assistant.listChats(user.uid, 300);
    const working = new Set([...this.runningAgent.values()].filter((r) => r.ownerId === user.uid).map((r) => r.agentId));
    return Promise.all(
      list.map(async (a) => {
        const ai = creds.get(a.aiCredentialId ?? s.aiCredentialId ?? '');
        const service = ai?.details.aiService;
        return {
          agentId: a.agentId,
          name: a.name,
          avatar: a.avatar,
          color: a.color,
          title: a.title,
          department: a.department,
          description: a.description,
          responsibilities: a.responsibilities,
          expertise: a.expertise,
          visibility: a.visibility,
          status: a.status,
          builtIn: a.builtIn,
          lastActiveAt: a.lastActiveAt,
          model: a.model,
          canDelegate: a.canDelegate ?? false,
          aiName: ai ? `${service ? AI_SERVICE_INFO[service].label : ai.name} · ${a.model || ai.details.model || (service ? AI_SERVICE_INFO[service].defaultModel : '')}` : null,
          tools: a.tools,
          canManage: this.agents.canManage(user),
          canEdit: this.agents.canEdit(user, a),
          problem: await this.agentProblem(user, a),
          chats: chats.filter((c) => (c.agentId ?? DEFAULT_AGENT_ID) === a.agentId).length,
          working: working.has(a.agentId),
        };
      }),
    );
  }

  /** PMS data is for people who build workflows (not every employee), through a read-only connection. */
  private canUsePms(user: AppUser, pms: Credential | null) {
    return !!pms && !!pms.details.readOnly && hasPermission(user, 'workflow.create') && this.d.credentials.usableBy(pms, user.department);
  }

  /* --------------------------------------------------------------- chats */

  private publicChat(c: StoredAssistantChat): AssistantChat {
    return { chatId: c.chatId, ownerId: c.ownerId, agentId: c.agentId ?? DEFAULT_AGENT_ID, title: c.title, status: c.status, createdAt: c.createdAt, updatedAt: c.updatedAt };
  }

  private async ownChat(user: AppUser, chatId: string) {
    const c = await this.d.repos.assistant.getChat(chatId);
    if (!c || c.ownerId !== user.uid) throw notFound('Chat not found');
    // A run that died with a server restart: free the chat.
    if (c.status === 'running' && !this.running.has(chatId) && Date.now() - Date.parse(c.updatedAt) > STALE_MS) {
      await this.d.repos.assistant.updateChat(chatId, { status: 'idle', updatedAt: nowIso() });
      c.status = 'idle';
    }
    return c;
  }

  async listChats(user: AppUser, agentId: string = DEFAULT_AGENT_ID) {
    return (await this.d.repos.assistant.listChats(user.uid, 300))
      .filter((c) => (c.agentId ?? DEFAULT_AGENT_ID) === agentId)
      .slice(0, 100)
      .map((c) => this.publicChat(c));
  }

  async getChat(user: AppUser, chatId: string) {
    const c = await this.ownChat(user, chatId);
    const messages = await this.d.repos.assistant.listMessages(chatId, 100);
    const screen = this.d.browser?.screen(chatId);
    return { chat: this.publicChat(c), messages, screen: screen ? { at: screen.at, url: screen.url } : null };
  }

  async createChat(user: AppUser, firstText?: string, agentId: string = DEFAULT_AGENT_ID) {
    await this.agents.getForChat(user, agentId);
    const now = nowIso();
    const chat: StoredAssistantChat = { chatId: newId('chat'), ownerId: user.uid, agentId, title: 'New chat', status: 'idle', createdAt: now, updatedAt: now, transcriptJson: '[]', pendingJson: null };
    await this.d.repos.assistant.createChat(chat);
    if (firstText?.trim()) await this.send(user, chat.chatId, firstText);
    return this.publicChat((await this.d.repos.assistant.getChat(chat.chatId))!);
  }

  async deleteChat(user: AppUser, chatId: string) {
    await this.ownChat(user, chatId);
    this.running.get(chatId)?.abort();
    await this.d.browser?.close(chatId);
    await this.d.repos.assistant.deleteChat(chatId);
  }

  /* -------------------------------------------------------------- photos */

  /** Keeps a (browser-compressed) photo inside the chat, ready to be sent with the next message. */
  async uploadImage(user: AppUser, chatId: string, name: string, bytes: Buffer) {
    await this.ownChat(user, chatId);
    const info = imageInfo(bytes);
    if (!info) throw badRequest('This is not a photo the AI can read. Use JPG, PNG, WebP or GIF.');
    if (bytes.length > CHAT_IMAGE_LIMITS.maxBytes) throw badRequest('The photo is too large. It should be shrunk automatically — try again, or use a smaller photo.');
    if ((await this.d.repos.assistant.countImages(chatId)) >= CHAT_IMAGE_LIMITS.perChat) throw badRequest(`This chat already has ${CHAT_IMAGE_LIMITS.perChat} photos. Start a new chat.`);
    const img: ChatImage = {
      imageId: newId('img'),
      chatId,
      messageId: null,
      name: name.replace(/[\r\n“”]/g, ' ').trim().slice(0, 120) || 'photo',
      mime: info.mime,
      data: bytes.toString('base64'),
      bytes: bytes.length,
      width: info.width,
      height: info.height,
      createdAt: nowIso(),
    };
    await this.d.repos.assistant.addImage(img);
    return { imageId: img.imageId, name: img.name, width: img.width, height: img.height };
  }

  /** A photo of one of the person's own chats. */
  async image(user: AppUser, chatId: string, imageId: string) {
    await this.ownChat(user, chatId);
    const img = await this.d.repos.assistant.getImage(chatId, imageId);
    if (!img) throw notFound('Photo not found');
    return { mime: img.mime, bytes: Buffer.from(img.data, 'base64') };
  }

  /** The latest photos of a chat, for the AI to look at. */
  private async photosFor(chatId: string, transcript: TranscriptEntry[]) {
    const out: { mime: string; data: string }[] = [];
    for (const id of photoIds(transcript).reverse()) {
      const img = await this.d.repos.assistant.getImage(chatId, id).catch(() => null);
      if (img) out.push({ mime: img.mime, data: img.data });
    }
    return out;
  }

  /* ------------------------------------------------------------ messages */

  async send(user: AppUser, chatId: string, text: string, attachments: AttachmentText[] = [], imageIds: string[] = []) {
    const clean = text.trim().slice(0, MAX_TEXT);
    const files = attachments.slice(0, KNOWLEDGE_LIMITS.maxAttachments).filter((a) => a.text.trim());
    if (imageIds.length > CHAT_IMAGE_LIMITS.perMessage) throw badRequest(`Up to ${CHAT_IMAGE_LIMITS.perMessage} photos per message`);
    if (!clean && !files.length && !imageIds.length) throw badRequest('Type a message');
    let room = KNOWLEDGE_LIMITS.maxAttachmentChars;
    const attached = files.map((a) => {
      const body = a.text.trim().slice(0, Math.max(0, room));
      room -= body.length;
      return { name: a.name.slice(0, 120), kind: a.kind.slice(0, 20), body, cut: body.length < a.text.trim().length };
    });
    // Photos must have been uploaded to THIS chat and not used in another message.
    const photos: ChatImage[] = [];
    for (const id of [...new Set(imageIds)]) {
      const img = await this.d.repos.assistant.getImage(chatId, id);
      if (!img || img.messageId) throw badRequest('A photo is missing. Remove it and add it again.');
      photos.push(img);
    }
    const forAi =
      (clean || (photos.length ? 'Please look at the attached photo.' : 'Please look at the attached file.')) +
      photos.map((p) => `\n[Photo attached: “${p.name}” (photo ${p.imageId}) — you can see it]`).join('') +
      attached.map((a) => `${ATTACH_START}${a.name}” (${a.kind}) — its text${a.cut ? ' (only the beginning, it was too long)' : ''}:]\n"""\n${a.body}\n"""`).join('');
    const chat = await this.ownChat(user, chatId);
    const agent = await this.agents.getForChat(user, chat.agentId ?? DEFAULT_AGENT_ID);
    const problem = await this.agentProblem(user, agent);
    if (problem) throw badRequest(problem);
    if (chat.status === 'running') throw conflict('The assistant is still working on your last message. Wait, or press Stop.');
    const transcript: TranscriptEntry[] = JSON.parse(chat.transcriptJson || '[]');
    if (chat.pendingJson) {
      // A new message instead of Approve: treat it as “don’t do it”, then read the message.
      const p = JSON.parse(chat.pendingJson);
      if (p.approvalId) await this.approvals?.withdraw(p.approvalId, 'Not answered — the person sent another message instead');
      transcript.push({ role: 'tool', tool: p.tool, input: p.input, result: 'The person did not approve this. Do not do it unless they ask again.' });
      if (p.messageId) await this.d.repos.assistant.updateMessage(chatId, p.messageId, { status: 'done', pending: null, updatedAt: nowIso() });
    }
    transcript.push({ role: 'user', text: forAi });
    const now = nowIso();
    const userMessageId = newId('msg');
    for (const p of photos) await this.d.repos.assistant.updateImage(chatId, p.imageId, { messageId: userMessageId });
    await this.d.repos.assistant.addMessage({
      messageId: userMessageId,
      chatId,
      role: 'user',
      text: clean,
      status: 'done',
      steps: [],
      ...(attached.length ? { attachments: attached.map((a) => ({ name: a.name, kind: a.kind, chars: a.body.length })) } : {}),
      ...(photos.length ? { images: photos.map((p) => ({ imageId: p.imageId, name: p.name, width: p.width, height: p.height })) } : {}),
      createdAt: now,
      updatedAt: now,
    });
    // 1 ms later than the question, so the order of the two messages is always right.
    const later = new Date(Date.parse(now) + 1).toISOString();
    const reply: AssistantMessage = { messageId: newId('msg'), chatId, role: 'assistant', text: '', status: 'running', steps: [], pending: null, files: [], createdAt: later, updatedAt: later };
    await this.d.repos.assistant.addMessage(reply);
    await this.d.repos.assistant.updateChat(chatId, {
      status: 'running',
      pendingJson: null,
      transcriptJson: packTranscript(transcript),
      updatedAt: nowIso(),
      ...(chat.title === 'New chat' ? { title: (clean || attached[0]?.name || photos[0]?.name || 'Photo').replace(/\s+/g, ' ').slice(0, 60) } : {}),
    });
    void this.agents.touch(agent.agentId);
    this.start(user, chatId, agent, reply, transcript);
    return { messageId: reply.messageId };
  }

  /** Throw away the last answer and ask again (same question). */
  async regenerate(user: AppUser, chatId: string) {
    const chat = await this.ownChat(user, chatId);
    if (chat.status !== 'idle') throw conflict('Wait until the current answer is finished, or press Stop.');
    const agent = await this.agents.getForChat(user, chat.agentId ?? DEFAULT_AGENT_ID);
    const problem = await this.agentProblem(user, agent);
    if (problem) throw badRequest(problem);
    const msgs = await this.d.repos.assistant.listMessages(chatId, 100);
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (!lastUser) throw badRequest('There is nothing to answer again');
    for (const m of msgs) if (m.role === 'assistant' && m.createdAt > lastUser.createdAt) await this.d.repos.assistant.deleteMessage(chatId, m.messageId);
    const transcript: TranscriptEntry[] = JSON.parse(chat.transcriptJson || '[]');
    let cut = transcript.length;
    for (let i = transcript.length - 1; i >= 0; i--) {
      const e = transcript[i]!;
      if (e.role === 'user') {
        cut = i + 1;
        break;
      }
    }
    transcript.length = cut;
    const later = new Date(Math.max(Date.now(), Date.parse(lastUser.createdAt) + 1)).toISOString();
    const reply: AssistantMessage = { messageId: newId('msg'), chatId, role: 'assistant', text: '', status: 'running', steps: [], pending: null, files: [], createdAt: later, updatedAt: later };
    await this.d.repos.assistant.addMessage(reply);
    await this.d.repos.assistant.updateChat(chatId, { status: 'running', pendingJson: null, transcriptJson: packTranscript(transcript), updatedAt: nowIso() });
    this.start(user, chatId, agent, reply, transcript);
    return { messageId: reply.messageId };
  }

  /** The Approve / Don't do it buttons in the chat. Goes through the Approval Center rules. */
  async decide(user: AppUser, chatId: string, approve: boolean, confirmWord?: string) {
    const chat = await this.ownChat(user, chatId);
    if (!chat.pendingJson) throw conflict('Nothing is waiting for your approval');
    const p = JSON.parse(chat.pendingJson) as { tool: string; input: unknown; messageId: string; approvalId?: string };
    if (p.approvalId && this.approvals) {
      await this.approvals.decide(user, p.approvalId, { approve, confirmWord });
      return;
    }
    await this.resumeChat(user, chatId, p, approve, approve ? 'You approved' : 'You said no');
  }

  /** Called by the Approval Center after a decision (or expiry) about a chat request. */
  private async continueAfterDecision(a: import('@widebed/shared').AgentApproval, approved: boolean) {
    if (!a.chatId) return;
    const chat = await this.d.repos.assistant.getChat(a.chatId);
    if (!chat?.pendingJson) return;
    const p = JSON.parse(chat.pendingJson) as { tool: string; input: unknown; messageId: string; approvalId?: string };
    if (p.approvalId !== a.approvalId) return; // an older request
    const owner = await this.d.repos.users.get(chat.ownerId);
    if (!owner || owner.status !== 'active') return;
    const who = a.decidedBy ? (a.decidedBy === chat.ownerId ? 'You' : (await this.d.repos.users.get(a.decidedBy))?.name ?? 'An approver') : null;
    const label = a.status === 'expired' ? 'The request expired — nothing was done' : approved ? `${who} approved` : `${who ?? 'Someone'} said no${a.note ? `: “${a.note}”` : ''}`;
    // Exactly the approved parameters (an edit may have changed them).
    await this.resumeChat(owner as AppUser, a.chatId, { ...p, input: a.input }, approved, label);
  }

  private async resumeChat(user: AppUser, chatId: string, p: { tool: string; input: unknown; messageId: string }, approve: boolean, label: string) {
    const chat = await this.ownChat(user, chatId);
    const transcript: TranscriptEntry[] = JSON.parse(chat.transcriptJson || '[]');
    await this.d.repos.assistant.updateChat(chatId, { status: 'running', pendingJson: null, updatedAt: nowIso() });
    const msgs = await this.d.repos.assistant.listMessages(chatId, 100);
    const reply = msgs.find((m) => m.messageId === p.messageId);
    if (!reply) throw notFound('Message not found');
    reply.status = 'running';
    reply.pending = null;
    reply.steps.push({ id: newId('st'), label, status: approve ? 'done' : 'error', at: nowIso() });
    await this.d.repos.assistant.updateMessage(chatId, reply.messageId, { status: 'running', pending: null, steps: reply.steps, updatedAt: nowIso() });
    const agent = await this.agents.getForChat(user, chat.agentId ?? DEFAULT_AGENT_ID);
    this.start(user, chatId, agent, reply, transcript, { tool: p.tool, input: p.input, approved: approve });
  }

  async stop(user: AppUser, chatId: string) {
    await this.ownChat(user, chatId);
    this.running.get(chatId)?.abort();
  }

  /** Waits for the background run of a chat (tests). */
  async idle(chatId: string) {
    for (let i = 0; i < 400 && this.running.has(chatId); i++) await new Promise((r) => setTimeout(r, 25));
  }

  /* -------------------------------------------------------------- memory */

  async listMemories(user: AppUser, agentId: string = DEFAULT_AGENT_ID) {
    await this.agents.getFor(user, agentId);
    return (await agentMemories(this.d.repos, user.uid, agentId)).slice(0, MAX_MEMORIES);
  }

  async addMemory(user: AppUser, text: string, agentId: string = DEFAULT_AGENT_ID) {
    await this.agents.getFor(user, agentId);
    const t = text.trim().slice(0, 300);
    if (!t) throw badRequest('Write what the assistant should remember');
    const secret = memorySecretProblem(t);
    if (secret) throw badRequest(secret);
    if ((await agentMemories(this.d.repos, user.uid, agentId)).length >= MAX_MEMORIES) throw badRequest(`The memory is full (${MAX_MEMORIES} items). Delete some first.`);
    const m = { memoryId: newId('mem'), ownerId: user.uid, agentId, text: t, createdAt: nowIso() };
    await this.d.repos.assistant.addMemory(m);
    return m;
  }

  /** The person's own memory, or any memory for Admins (who review memory). Returns the memory. */
  private async memoryFor(user: AppUser, memoryId: string) {
    const m = await this.d.repos.assistant.getMemory(memoryId);
    if (!m || (m.ownerId !== user.uid && !this.agents.canManage(user))) throw notFound('Memory not found');
    return m;
  }

  async deleteMemory(user: AppUser, memoryId: string) {
    const m = await this.memoryFor(user, memoryId);
    await this.d.repos.assistant.deleteMemory(memoryId);
    return m;
  }

  async updateMemory(user: AppUser, memoryId: string, text: string) {
    const m = await this.memoryFor(user, memoryId);
    const t = text.trim().slice(0, 300);
    if (!t) throw badRequest('Write what it should remember, or delete it');
    const secret = memorySecretProblem(t);
    if (secret) throw badRequest(secret);
    await this.d.repos.assistant.updateMemory(memoryId, { text: t });
    return { ...m, text: t };
  }

  /** Admins: everything one AI employee remembers, about everyone (to check and correct it). */
  async reviewMemories(user: AppUser, agentId: string) {
    if (!this.agents.canManage(user)) throw forbidden('Only Admins can review memory');
    await this.agents.getFor(user, agentId);
    const users = new Map((await this.d.repos.users.list(1000)).map((u) => [u.uid, u]));
    return (await this.d.repos.assistant.listAllMemories(5000))
      .filter((m) => (m.agentId ?? DEFAULT_AGENT_ID) === agentId)
      .map((m) => ({ ...m, ownerName: users.get(m.ownerId)?.name ?? 'Removed person', ownerEmail: users.get(m.ownerId)?.email ?? null }));
  }

  async readFile(user: AppUser, fileId: string) {
    const f = await this.d.browser?.readFile(fileId);
    if (!f || f.meta.ownerId !== user.uid) throw notFound('File not found (files are kept for 7 days)');
    return f;
  }

  screen(user: AppUser, chatId: string) {
    return this.ownChat(user, chatId).then(() => this.d.browser?.screen(chatId) ?? null);
  }

  /* ---------------------------------------------------------- the run */

  private async toolsFor(
    user: AppUser,
    chatId: string,
    opts: { agentId?: string; memory?: boolean; knowledge?: boolean; workflows: boolean; pms: boolean; browser?: boolean; websites: string[] | 'all'; onFile?: (f: SavedFile) => Promise<void>; delegate?: { agent: AiAgent; chatId?: string; taskId?: string }; siteFilters?: (string[] | 'all')[] },
  ) {
    const s = await this.settings();
    const tools: AgentTool[] = opts.memory === false ? [] : [...memoryTools(this.d.repos, user, opts.agentId ?? DEFAULT_AGENT_ID)];
    if (opts.knowledge !== false) {
      // Only offered when there is at least one document this person and this AI may use.
      const agentId = opts.agentId ?? DEFAULT_AGENT_ID;
      if ((await this.knowledge.list(user)).items.some((d) => !d.agentIds.length || d.agentIds.includes(agentId))) tools.push(...knowledgeTools(this.knowledge, user, agentId));
    }
    if (opts.workflows) tools.push(...workflowTools(this.d.repos, this.d.executions, user, this.d.workflowWait));
    if (opts.pms && s.pmsCredentialId) {
      const pms = await this.d.repos.credentials.get(s.pmsCredentialId);
      if (pms && this.canUsePms(user, pms)) tools.push(...pmsTools(this.d.credentials, pms.credentialId, user.department, pms.details.allowedCollections ?? []));
    }
    if (s.browserEnabled && this.d.browser && opts.browser !== false) {
      const matches = (list: string[] | 'all', c: { credentialId: string; name: string }) => list === 'all' || list.some((w) => w === c.credentialId || w.toLowerCase() === c.name.toLowerCase());
      const sites = (await this.d.credentials.listVisible(user)).filter(
        (c) => c.provider === 'website_login' && this.d.credentials.usableBy(c, user.department) && [opts.websites, ...(opts.siteFilters ?? [])].every((l) => matches(l, c)),
      );
      if (sites.length) tools.push(...browserTools({ sessions: this.d.browser, credentials: this.d.credentials, user, chatId, websites: sites, onFile: opts.onFile }));
    }
    // A manager can hand work to other AI staff (never from inside delegated work).
    if (opts.delegate?.agent.canDelegate && this.delegation) tools.push(...this.delegation(user, opts.delegate.agent, { chatId: opts.delegate.chatId ?? null, taskId: opts.delegate.taskId ?? null }));
    return tools;
  }

  private delegation: ((user: AppUser, manager: AiAgent, origin: { chatId: string | null; taskId: string | null }) => AgentTool[]) | null = null;
  /** Connects the Main Manager's delegate tools (set up by the task service). */
  useDelegation(fn: (user: AppUser, manager: AiAgent, origin: { chatId: string | null; taskId: string | null }) => AgentTool[]) {
    this.delegation = fn;
  }

  private async context(user: AppUser, tools: AgentTool[] = [], agent?: AiAgent) {
    const memories = agent && !agent.memoryEnabled ? [] : (await agentMemories(this.d.repos, user.uid, agent?.agentId ?? DEFAULT_AGENT_ID)).slice(0, MAX_MEMORIES);
    const t = todayInfo();
    const has = (prefix: string) => tools.some((x) => x.name.startsWith(prefix));
    return [
      `What you can use right now: Company Knowledge ${has('search_knowledge') ? 'YES (search it for company rules and procedures before answering)' : 'NO'}, PMS data ${has('pms_') ? 'YES' : 'NO (not connected for this person)'}, workflows ${has('list_workflows') ? 'YES' : 'NO'}, web browser ${has('browser_') ? 'YES' : 'NO (switched off or no saved website)'}.`,
      `You are talking with ${user.name} (${user.role.replace('_', ' ')}${user.department ? `, ${user.department} department` : ''}).`,
      `Today is ${t.weekday}, ${t.display} (${t.date}), Malaysia time.`,
      agent && !agent.memoryEnabled
        ? 'Your memory is switched off: do not try to remember things.'
        : memories.length
          ? `What you remember about ${user.name} (ids for “forget”):\n${memories.map((m) => `- [${m.memoryId}] ${m.text}`).join('\n')}`
          : `You do not remember anything about ${user.name} yet.`,
    ].join('\n');
  }

  private async aiFor(user: AppUser, agent: AiAgent | undefined, source: 'chat' | 'task') {
    const s = await this.settings();
    const id = agent?.aiCredentialId ?? s.aiCredentialId;
    if (!id) throw new Error('No AI service is chosen for the assistant');
    return async (req: Parameters<CredentialService['ai']>[2], onText?: (soFar: string) => void) => {
      const res = await this.d.credentials.ai(id, user.department, req, { model: agent?.model ?? null, temperature: agent?.temperature ?? null, onText });
      // AI Performance: count every call (never blocks or breaks the answer).
      void this.d.repos.usage
        .add({
          day: myDay(),
          agentId: agent?.agentId ?? DEFAULT_AGENT_ID,
          agentName: agent?.name ?? 'Widebed Assistant',
          department: agent?.department ?? null,
          model: res.model || 'unknown',
          calls: 1,
          chatCalls: source === 'chat' ? 1 : 0,
          taskCalls: source === 'task' ? 1 : 0,
          inputTokens: res.inputTokens ?? 0,
          outputTokens: res.outputTokens ?? 0,
        })
        .catch(() => undefined);
      return res;
    };
  }

  private start(user: AppUser, chatId: string, agent: AiAgent, reply: AssistantMessage, transcript: TranscriptEntry[], resume?: { tool: string; input: unknown; approved: boolean }) {
    const ctrl = new AbortController();
    this.running.set(chatId, ctrl);
    this.runningAgent.set(chatId, { agentId: agent.agentId, ownerId: user.uid });
    this.emit(chatId, { type: 'changed' });
    void this.run(user, chatId, agent, reply, transcript, ctrl, resume).finally(() => {
      if (this.running.get(chatId) === ctrl) {
        this.running.delete(chatId);
        this.runningAgent.delete(chatId);
      }
      this.emit(chatId, { type: 'changed' });
    });
  }

  private async run(user: AppUser, chatId: string, agent: AiAgent, reply: AssistantMessage, transcript: TranscriptEntry[], ctrl: AbortController, resume?: { tool: string; input: unknown; approved: boolean }) {
    const repo = this.d.repos.assistant;
    const steps: AssistantStep[] = reply.steps ?? [];
    const files = reply.files ?? [];
    const byKey = new Map<string, AssistantStep>();
    let saving = Promise.resolve();
    const save = (patch: Partial<AssistantMessage> = {}) => {
      saving = saving
        .then(() => repo.updateMessage(chatId, reply.messageId, { steps: [...steps], files: [...files], updatedAt: nowIso(), ...patch }))
        .then(() => this.emit(chatId, { type: 'changed' }))
        .catch(() => undefined);
      return saving;
    };
    const onStep = async (e: AgentStepEvent) => {
      let st = byKey.get(e.stepKey);
      if (!st) {
        // Hide the “Thinking…” steps once done, so the list shows real work.
        st = { id: e.stepKey, label: e.label, status: 'running', at: nowIso() };
        byKey.set(e.stepKey, st);
        steps.push(st);
      }
      st.status = e.kind === 'start' || e.kind === 'progress' ? 'running' : e.kind === 'done' ? 'done' : 'error';
      if (e.detail) st.detail = e.detail.slice(0, 300);
      if (e.kind === 'done' && st.label === 'Thinking…') steps.splice(steps.indexOf(st), 1);
      await save();
    };

    let outcome: AgentOutcome;
    let failed = false;
    try {
      const tools = await this.toolsFor(user, chatId, {
        agentId: agent.agentId,
        memory: agent.memoryEnabled && agent.tools.memory,
        knowledge: agent.tools.knowledge !== false,
        workflows: agent.tools.workflows,
        pms: agent.tools.pms,
        browser: agent.tools.browser,
        websites: agent.tools.websites,
        delegate: { agent, chatId },
        onFile: async (f) => {
          files.push({ fileId: f.fileId, name: f.name, size: f.size });
          await save();
        },
      });
      const images = await this.photosFor(chatId, transcript);
      outcome = await runAgent({
        ai: await this.aiFor(user, agent, 'chat'),
        identity: agent.builtIn ? undefined : identityText(agent),
        context: (await this.context(user, tools, agent)) + (images.length ? `\nPhotos: you can SEE the ${images.length === 1 ? 'photo' : `${images.length} latest photos`} the person attached in this chat (in the order they were sent). Describe only what is really visible; say so when something is unclear.` : ''),
        images,
        tools,
        transcript,
        onStep,
        signal: ctrl.signal,
        resume,
        maxRounds: agent.maxSteps,
        maxTokens: agent.maxOutputTokens,
        onAnswerText: (text) => this.emit(chatId, { type: 'text', messageId: reply.messageId, text }),
        gate: this.approvals?.gateFor({ chatId, inChat: true }),
        onToolDone: (tool, input, ok) => (ok ? this.approvals?.markUsedIfGranted({ chatId }, tool, input) : undefined),
      });
    } catch (err) {
      outcome = { kind: 'answer', text: `Sorry, something went wrong: ${(err as Error).message}` };
      failed = true;
    }
    await saving;

    const base = { transcriptJson: packTranscript(transcript.slice(-80)), updatedAt: nowIso() };
    switch (outcome.kind) {
      case 'approval': {
        const chat = await repo.getChat(chatId);
        const ap = this.approvals
          ? await this.approvals.create({
              source: 'chat',
              chatId,
              agent,
              requestedFor: user.uid,
              title: chat?.title ?? 'Chat',
              tool: outcome.tool,
              toolLabel: outcome.label,
              input: outcome.input,
              details: outcome.details,
              target: outcome.target,
              level: outcome.level,
              reason: outcome.say,
            })
          : null;
        await save({
          status: 'waiting_approval',
          text: outcome.say || 'I need your OK before I do this:',
          pending: { tool: outcome.tool, label: outcome.label, details: outcome.details, level: outcome.level, target: outcome.target, approvalId: ap?.approvalId ?? null, expiresAt: ap?.expiresAt ?? null },
        });
        await repo.updateChat(chatId, { ...base, status: 'waiting', pendingJson: JSON.stringify({ tool: outcome.tool, input: outcome.input, messageId: reply.messageId, approvalId: ap?.approvalId ?? null }) });
        return;
      }
      case 'ask':
        await save({ status: 'waiting_input', text: outcome.text });
        break;
      case 'stopped':
        await save({ status: 'stopped', text: reply.text || 'Stopped.' });
        await this.d.browser?.close(chatId);
        break;
      default:
        await save({ status: failed ? 'error' : 'done', text: outcome.text });
    }
    await repo.updateChat(chatId, { ...base, status: 'idle', pendingJson: null });
  }

  /* --------------------------------------------- Stage 4: scheduled agent */

  /** Runs the assistant without a person (AI Agent workflow step). Returns its final answer and the steps it took. */
  async runHeadless(user: AppUser, req: HeadlessAgentRequest): Promise<{ answer: string; steps: string[]; files: SavedFile[]; pending?: HeadlessPending; transcript: TranscriptEntry[] }> {
    const agent = await this.agents.getForChat(user, req.agentId ?? DEFAULT_AGENT_ID).catch(() => {
      throw new Error('This AI employee does not exist, is switched off, or this person may not use it.');
    });
    const problem = await this.agentProblem(user, agent);
    if (problem) throw new Error(problem);
    const chatId = req.sessionId ?? newId('job');
    const files: SavedFile[] = [];
    const steps: string[] = [];
    try {
      const lim = req.toolLimit ?? null;
      let tools = await this.toolsFor(user, chatId, {
        agentId: agent.agentId,
        memory: agent.memoryEnabled && agent.tools.memory,
        knowledge: agent.tools.knowledge !== false && (!lim || lim.knowledge !== false),
        workflows: req.useWorkflows && (agent.builtIn || agent.tools.workflows) && (!lim || lim.workflows),
        pms: req.usePms && (agent.builtIn || agent.tools.pms) && (!lim || lim.pms),
        browser: (agent.builtIn || agent.tools.browser) && (!lim || lim.browser),
        websites: req.websites,
        siteFilters: [agent.tools.websites, lim ? lim.websites : 'all'],
        onFile: async (f) => void files.push(f),
        delegate: lim ? undefined : { agent, taskId: req.taskId },
      });
      if (req.allowActions) tools = tools.map((t) => ({ ...t, approval: undefined, risk: undefined }));
      const transcript: TranscriptEntry[] = req.transcript?.length ? req.transcript : [{ role: 'user', text: req.goal }];
      const outcome = await runAgent({
        ai: await this.aiFor(user, agent, 'task'),
        identity: agent.builtIn ? undefined : identityText(agent),
        maxRounds: agent.maxSteps,
        maxTokens: agent.maxOutputTokens,
        context: `${await this.context(user, tools, agent)}\nThis is an automatic run from a scheduled workflow: nobody is watching, finish on your own.`,
        tools,
        transcript,
        interactive: false,
        signal: req.signal,
        resume: req.resume,
        gate: req.allowActions ? undefined : req.gate,
        onToolDone: req.onToolDone,
        onStep: async (e) => {
          if (e.kind === 'done' && e.label !== 'Thinking…') steps.push(e.label);
          if (e.kind === 'error') steps.push(`${e.label} — failed: ${e.detail ?? ''}`);
          await req.onStep?.(e);
        },
        onUsage: req.onUsage,
      });
      if (outcome.kind === 'approval') {
        const { kind: _k, ...pending } = outcome;
        return { answer: '', steps, files, pending, transcript };
      }
      const answer = outcome.kind === 'answer' || outcome.kind === 'limit' ? outcome.text : outcome.kind === 'stopped' ? 'Stopped.' : 'The assistant needed a person and could not finish.';
      return { answer, steps, files, transcript };
    } finally {
      await this.d.browser?.close(chatId);
    }
  }
}
