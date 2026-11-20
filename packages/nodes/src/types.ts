import type { z } from 'zod';
import type { Item, NodeDescriptor, WorkflowNode } from '@widebed/shared';
import type { SafeHttpClient } from './http/safe-http.js';

/**
 * Node execution contract.
 *
 * Every node type implements `NodeImplementation`. The engine:
 *   1. validates `node.config` with `configSchema` before the run starts,
 *   2. collects input items from upstream connections,
 *   3. calls `execute(ctx)` and routes `outputs[handleId]` to downstream nodes.
 *
 * Nodes never talk to Firestore, the queue or the network directly. They get
 * what they are allowed to use through `ctx.services`, which keeps them
 * testable and lets the platform enforce security (SSRF, credentials, limits).
 */

/** A request to an AI service (OpenAI, Claude, Gemini) through an AI connection. */
export interface AiRequest {
  prompt: string;
  system?: string;
  /** Ask for one JSON object as the answer. */
  json?: boolean;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Pictures for the AI to look at (base64, no data: prefix). Needs a model that can see images. */
  images?: AiImage[];
}
export interface AiImage {
  mime: string;
  data: string;
}
export interface AiResponse {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AgentRunRequest {
  goal: string;
  useWorkflows: boolean;
  usePms: boolean;
  websites: string[];
  allowActions: boolean;
  /** AI employee (name or id) who does the job; empty = the Widebed Assistant. */
  agent?: string;
  signal?: AbortSignal;
}
export interface AgentRunResult {
  answer: string;
  steps: string[];
  files: { fileId: string; name: string; size: number }[];
}

/** One message of a remembered chatbot conversation. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

/** Remembered conversations of chatbot nodes, kept per workflow and conversation id. */
export interface ChatMemoryAccess {
  load(conversationId: string): Promise<ChatTurn[]>;
  save(conversationId: string, turns: ChatTurn[]): Promise<void>;
  clear(conversationId: string): Promise<void>;
}

/** An API key connection, for the HTTP Request node only. */
export interface ApiKeyAccess {
  name: string;
  headerName: string;
  value: string;
  /** Hosts the key may be sent to (and their sub-domains). */
  allowedDomains: string[];
}

export interface NodeServices {
  http: SafeHttpClient;
  /** API key connection: header name + value, and where it may be sent. */
  apiKey?: (credentialId: string) => Promise<ApiKeyAccess>;
  /** Sets the answer a waiting webhook caller (e.g. a website chat box) receives. */
  respond?: (res: { status: number; body: unknown; contentType: 'json' | 'text' }) => Promise<void>;
  /** Conversation memory for chatbot nodes (scoped to this workflow by the platform). */
  chatMemory?: ChatMemoryAccess;
  /** Firestore of an outside project, restricted to the credential's allowed collections. */
  firestore?: (credentialId: string) => Promise<FirestoreAccess>;
  /** Fresh Google access token for a connected Google account. */
  googleToken?: (credentialId: string) => Promise<{ accessToken: string; email: string | null; scopes?: string[] }>;
  /** Asks the AI service of an AI connection. The API key never reaches the node. */
  ai?: (credentialId: string, req: AiRequest) => Promise<AiResponse>;
  /** Runs the Widebed Assistant without a person (AI Agent step). */
  agent?: (req: AgentRunRequest) => Promise<AgentRunResult>;
  /** Runs user JavaScript in an isolated child process. */
  runCode?: (code: string, input: unknown, opts: { timeoutMs: number; signal: AbortSignal }) => Promise<unknown>;
  /** Pauses the run (status "waiting") for up to the platform's maximum wait. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type FirestoreOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'array-contains' | 'in';

export interface FirestoreDoc {
  id: string;
  path: string;
  data: Record<string, unknown>;
}

/** What Firebase nodes may do. The API enforces the collection allow-list and read-only flag. */
export interface FirestoreAccess {
  get(docPath: string): Promise<FirestoreDoc | null>;
  query(
    collectionPath: string,
    opts: { where: { field: string; op: FirestoreOp; value: unknown }[]; orderBy?: { field: string; direction: 'asc' | 'desc' }; limit: number },
  ): Promise<FirestoreDoc[]>;
  create(collectionPath: string, data: Record<string, unknown>, docId?: string): Promise<{ id: string; path: string }>;
  update(docPath: string, data: Record<string, unknown>, merge: boolean): Promise<void>;
  delete(docPath: string): Promise<void>;
}

/** Helper for nodes that need a service: fails clearly if the platform did not provide it. */
export function requireService<K extends keyof NodeServices>(services: NodeServices, key: K, what: string): NonNullable<NodeServices[K]> {
  const svc = services[key];
  if (!svc) throw new NodeError(`${what} is not available in this environment`, { code: 'SERVICE_UNAVAILABLE' });
  return svc as NonNullable<NodeServices[K]>;
}

export interface NodeExecutionContext<C = Record<string, unknown>> {
  executionId: string;
  workflowId: string;
  node: WorkflowNode;
  /** Validated (but not yet expression-resolved) config. */
  config: C;
  /** Items arriving at the "main" input (most nodes only use this). */
  items: Item[];
  /** Items per input handle, for nodes with several inputs. */
  inputs: Record<string, Item[]>;
  /** Resolves {{ expressions }} inside any value for a given item. */
  resolve: <T>(value: T, item?: Item, itemIndex?: number) => T;
  signal: AbortSignal;
  services: NodeServices;
  log: (message: string, data?: unknown) => void;
}

export interface NodeResult {
  /** Items emitted per output handle. Handles left out emit nothing. */
  outputs: Record<string, Item[]>;
}

export interface NodeImplementation<S extends z.ZodTypeAny = z.ZodTypeAny> {
  descriptor: NodeDescriptor;
  configSchema: S;
  execute(ctx: NodeExecutionContext<z.infer<S>>): Promise<NodeResult>;
}

/** Errors thrown by nodes. `retryable` tells the engine whether a retry can help. */
export class NodeError extends Error {
  constructor(
    message: string,
    public readonly options: { code?: string; retryable?: boolean; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'NodeError';
  }
  get code() {
    return this.options.code;
  }
  get retryable() {
    return this.options.retryable ?? false;
  }
}

export function defineNode<S extends z.ZodTypeAny>(impl: NodeImplementation<S>): NodeImplementation<S> {
  return impl;
}
