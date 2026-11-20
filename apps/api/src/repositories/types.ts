import type {
  AppUser,
  Credential,
  Execution,
  ExecutionStatus,
  ExecutionStep,
  Item,
  TriggerType,
  Workflow,
  WorkflowFolder,
  WorkflowTemplate,
  WorkflowVersion,
  AssistantChat,
  AssistantMessage,
  AssistantMemory,
  AiAgent,
  AgentTask,
  AgentSchedule,
  AgentResponsibility,
  AppNotification,
  AgentApproval,
  AgentProject,
  KnowledgeChunk,
  UsageRow,
  ChatImage,
  KnowledgeDoc,
} from '@widebed/shared';

/**
 * Persistence contracts. Production uses Firestore (./firestore.ts).
 * Tests use the in-memory version (./memory.ts). Services only see these
 * interfaces, so swapping the implementation never touches business logic.
 */

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Stored execution = public fields + server-only replay payload. */
export interface StoredExecution extends Execution {
  /** Raw trigger items: what the run starts with (and replays on retry). Never returned by the API. */
  triggerItems: Item[] | null;
  triggerNodeId: string | null;
  /** Draft test runs only: a frozen copy of the draft taken when the run was requested. */
  definitionJson?: string | null;
  /** "Test node" runs stop after this node. */
  untilNodeId?: string | null;
  /** Webhook runs: the answer set by a "Respond to Webhook" step, as JSON ({ status, body }). Never returned by the API. */
  webhookResponseJson?: string | null;
}

export interface WebhookEndpoint {
  webhookId: string;
  workflowId: string;
  nodeId: string;
  endpointTokenHash: string;
  /** AES-GCM encrypted HMAC signing secret. */
  signingSecretEncrypted: string;
  /** AES-GCM encrypted URL token, so editors can see the URL again (endpoints made before 20 Nov 2026 have none). */
  endpointTokenEncrypted?: string;
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface AuditLog {
  logId: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface ExecutionFilter {
  workflowId?: string;
  status?: ExecutionStatus;
  triggerType?: TriggerType;
  department?: string;
  initiatedBy?: string;
  from?: string;
  to?: string;
}

export interface UsersRepo {
  get(uid: string): Promise<AppUser | null>;
  create(user: AppUser): Promise<void>;
  update(uid: string, patch: Partial<AppUser>): Promise<void>;
  list(limit: number): Promise<AppUser[]>;
}

export interface WorkflowsRepo {
  get(id: string): Promise<Workflow | null>;
  create(wf: Workflow): Promise<void>;
  update(id: string, patch: Partial<Workflow>): Promise<void>;
  delete(id: string): Promise<void>;
  /** Visible lists, newest first. */
  listAll(limit: number): Promise<Workflow[]>;
  listByDepartment(department: string, limit: number): Promise<Workflow[]>;
  listByOwner(uid: string, limit: number): Promise<Workflow[]>;
  listSharedWith(uid: string, limit: number): Promise<Workflow[]>;
  count(filter: { status?: 'active' | 'inactive' }): Promise<number>;
  /** Active workflows whose published version listens to this event name. */
  listActiveByEvent(eventName: string, limit: number): Promise<Workflow[]>;
  listActive(limit: number): Promise<Workflow[]>;
  /**
   * Atomically allocates the next version number, stores the immutable
   * snapshot and points the workflow at it.
   */
  publish(workflowId: string, build: (nextNumber: number, wf: Workflow) => WorkflowVersion): Promise<WorkflowVersion>;
}

export interface VersionsRepo {
  get(versionId: string): Promise<WorkflowVersion | null>;
  listByWorkflow(workflowId: string, limit: number): Promise<WorkflowVersion[]>;
  deleteByWorkflow(workflowId: string): Promise<void>;
}

export interface ExecutionsRepo {
  /** Returns false if an execution with this id already exists (idempotency). */
  createIfAbsent(exec: StoredExecution): Promise<boolean>;
  get(id: string): Promise<StoredExecution | null>;
  update(id: string, patch: Partial<StoredExecution>): Promise<void>;
  list(filter: ExecutionFilter, limit: number, cursor?: string): Promise<Page<Execution>>;
  count(filter: ExecutionFilter): Promise<number>;
  listByStatus(statuses: ExecutionStatus[], limit: number): Promise<StoredExecution[]>;
  upsertStep(step: ExecutionStep): Promise<void>;
  listSteps(executionId: string): Promise<ExecutionStep[]>;
}

export interface FoldersRepo {
  get(id: string): Promise<WorkflowFolder | null>;
  create(f: WorkflowFolder): Promise<void>;
  update(id: string, patch: Partial<WorkflowFolder>): Promise<void>;
  delete(id: string): Promise<void>;
  list(limit: number): Promise<WorkflowFolder[]>;
}

export interface TemplatesRepo {
  get(id: string): Promise<WorkflowTemplate | null>;
  create(t: WorkflowTemplate): Promise<void>;
  delete(id: string): Promise<void>;
  list(limit: number): Promise<WorkflowTemplate[]>;
}

/** Server-only fields of a chat (never sent to the browser). */
export interface StoredAssistantChat extends AssistantChat {
  transcriptJson: string;
  pendingJson: string | null;
}

export interface AssistantRepo {
  createChat(c: StoredAssistantChat): Promise<void>;
  getChat(id: string): Promise<StoredAssistantChat | null>;
  updateChat(id: string, patch: Partial<StoredAssistantChat>): Promise<void>;
  listChats(ownerId: string, limit: number): Promise<StoredAssistantChat[]>;
  deleteChat(id: string): Promise<void>;
  addMessage(m: AssistantMessage): Promise<void>;
  updateMessage(chatId: string, messageId: string, patch: Partial<AssistantMessage>): Promise<void>;
  listMessages(chatId: string, limit: number): Promise<AssistantMessage[]>;
  deleteMessage(chatId: string, messageId: string): Promise<void>;
  addImage(img: ChatImage): Promise<void>;
  getImage(chatId: string, imageId: string): Promise<ChatImage | null>;
  updateImage(chatId: string, imageId: string, patch: Partial<ChatImage>): Promise<void>;
  countImages(chatId: string): Promise<number>;
  listMemories(ownerId: string, limit: number): Promise<AssistantMemory[]>;
  /** Everyone's memories (Admin review). */
  listAllMemories(limit: number): Promise<AssistantMemory[]>;
  updateMemory(id: string, patch: Partial<AssistantMemory>): Promise<void>;
  addMemory(m: AssistantMemory): Promise<void>;
  getMemory(id: string): Promise<AssistantMemory | null>;
  deleteMemory(id: string): Promise<void>;
}

export interface AgentsRepo {
  get(id: string): Promise<AiAgent | null>;
  list(limit: number): Promise<AiAgent[]>;
  create(a: AiAgent): Promise<void>;
  update(id: string, patch: Partial<AiAgent>): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface AgentTasksRepo {
  /** Fails if the id exists (used to run each schedule occurrence once). */
  create(t: AgentTask): Promise<void>;
  get(id: string): Promise<AgentTask | null>;
  update(id: string, patch: Partial<AgentTask>): Promise<void>;
  /** Newest first. Filtering happens in the service (no composite indexes needed). */
  listRecent(limit: number): Promise<AgentTask[]>;
  listByStatus(statuses: string[], limit: number): Promise<AgentTask[]>;
}

export interface AgentSchedulesRepo {
  create(s: AgentSchedule): Promise<void>;
  get(id: string): Promise<AgentSchedule | null>;
  update(id: string, patch: Partial<AgentSchedule>): Promise<void>;
  delete(id: string): Promise<void>;
  list(limit: number): Promise<AgentSchedule[]>;
}

export interface AgentResponsibilitiesRepo {
  create(r: AgentResponsibility): Promise<void>;
  get(id: string): Promise<AgentResponsibility | null>;
  update(id: string, patch: Partial<AgentResponsibility>): Promise<void>;
  delete(id: string): Promise<void>;
  list(limit: number): Promise<AgentResponsibility[]>;
}

export interface ApprovalsRepo {
  create(a: AgentApproval): Promise<void>;
  get(id: string): Promise<AgentApproval | null>;
  /** Newest first. */
  listRecent(limit: number): Promise<AgentApproval[]>;
  listByStatus(status: string, limit: number): Promise<AgentApproval[]>;
  /**
   * Changes the status only if it is still `from` (atomic). Returns false if someone else
   * already decided — this is what makes an approval single-use.
   */
  transition(id: string, from: AgentApproval['status'], patch: Partial<AgentApproval>): Promise<boolean>;
  /** Sets usedAt once (atomic). Returns false if it was already used. */
  markUsed(id: string, at: string): Promise<boolean>;
}

export interface ProjectsRepo {
  create(p: AgentProject): Promise<void>;
  get(id: string): Promise<AgentProject | null>;
  update(id: string, patch: Partial<AgentProject>): Promise<void>;
  /** Newest first. */
  listRecent(limit: number): Promise<AgentProject[]>;
}

export interface KnowledgeRepo {
  /** Saves the document and all its text pieces. */
  create(d: KnowledgeDoc, chunks: KnowledgeChunk[]): Promise<void>;
  get(id: string): Promise<KnowledgeDoc | null>;
  update(id: string, patch: Partial<KnowledgeDoc>): Promise<void>;
  /** Swaps all text pieces (when the text is edited). */
  replaceChunks(id: string, chunks: KnowledgeChunk[]): Promise<void>;
  /** Removes the document and its pieces. */
  delete(id: string): Promise<void>;
  list(limit: number): Promise<KnowledgeDoc[]>;
  /** All pieces of one document, in order. */
  chunks(id: string): Promise<KnowledgeChunk[]>;
  /** Pieces containing any of these words (max 30 words). */
  findChunks(terms: string[], limit: number): Promise<KnowledgeChunk[]>;
}

export interface UsageRepo {
  /** Adds to the counters of one day × AI employee × model. */
  add(row: UsageRow): Promise<void>;
  /** Rows with fromDay <= day <= toDay. */
  list(fromDay: string, toDay: string): Promise<UsageRow[]>;
}

export interface NotificationsRepo {
  create(n: AppNotification): Promise<void>;
  get(id: string): Promise<AppNotification | null>;
  /** Newest first. */
  listForUser(userId: string, limit: number): Promise<AppNotification[]>;
  markRead(id: string): Promise<void>;
  markAllRead(userId: string): Promise<number>;
}

/** Remembered conversations of AI Chatbot nodes: workflowChatMemory/{id}. Expire after 90 days without use. */
export interface StoredChatMemory {
  workflowId: string;
  turns: { role: 'user' | 'assistant'; text: string; at: string }[];
  updatedAt: string;
}
export interface ChatMemoryRepo {
  get(id: string): Promise<StoredChatMemory | null>;
  set(id: string, value: StoredChatMemory): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface SettingsRepo {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

export interface WebhooksRepo {
  create(w: WebhookEndpoint): Promise<void>;
  findByTokenHash(hash: string): Promise<WebhookEndpoint | null>;
  listByWorkflow(workflowId: string): Promise<WebhookEndpoint[]>;
  update(id: string, patch: Partial<WebhookEndpoint>): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface CredentialsRepo {
  get(id: string): Promise<Credential | null>;
  list(limit: number): Promise<Credential[]>;
  create(c: Credential): Promise<void>;
  update(id: string, patch: Partial<Credential>): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Encrypted secrets, kept in a separate collection from the metadata. */
export interface CredentialSecretsRepo {
  get(id: string): Promise<string | null>;
  set(id: string, encrypted: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface AuditRepo {
  add(log: AuditLog): Promise<void>;
  list(limit: number, cursor?: string): Promise<Page<AuditLog>>;
}

export interface Repositories {
  users: UsersRepo;
  workflows: WorkflowsRepo;
  versions: VersionsRepo;
  executions: ExecutionsRepo;
  folders: FoldersRepo;
  templates: TemplatesRepo;
  assistant: AssistantRepo;
  agents: AgentsRepo;
  agentTasks: AgentTasksRepo;
  agentSchedules: AgentSchedulesRepo;
  responsibilities: AgentResponsibilitiesRepo;
  notifications: NotificationsRepo;
  approvals: ApprovalsRepo;
  projects: ProjectsRepo;
  knowledge: KnowledgeRepo;
  usage: UsageRepo;
  settings: SettingsRepo;
  chatMemory: ChatMemoryRepo;
  webhooks: WebhooksRepo;
  audit: AuditRepo;
  credentials: CredentialsRepo;
  credentialSecrets: CredentialSecretsRepo;
  /** Cheap round-trip used by health checks. */
  ping(): Promise<void>;
}
