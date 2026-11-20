import type { NodeRegistry } from '@widebed/nodes';
import type { Repositories } from './repositories/types.js';
import type { ExecutionService } from './services/execution-service.js';
import type { WebhookService } from './services/webhook-service.js';
import type { EventBus } from './services/event-bus.js';
import type { AuditFn } from './services/audit.js';
import type { CredentialService } from './services/credential-service.js';
import type { Scheduler } from './services/scheduler.js';
import type { TokenVerifier } from './auth/verifier.js';
import type { UserDirectory } from './auth/user-directory.js';
import type { SecretBox } from './lib/crypto.js';
import type { AssistantService } from './assistant/service.js';
import type { BrowserSessions } from './assistant/browser.js';
import type { SystemService } from './services/system-service.js';
import type { AgentTaskService } from './assistant/tasks.js';
import type { NotificationService } from './services/notifications.js';
import type { ApprovalService } from './assistant/approvals.js';
import type { KnowledgeService } from './services/knowledge.js';

/** Everything route handlers and workers need, created once at startup. */
export interface AppContext {
  repos: Repositories;
  registry: NodeRegistry;
  executions: ExecutionService;
  webhooks: WebhookService;
  credentials: CredentialService;
  assistant: AssistantService;
  system: SystemService;
  agentTasks: AgentTaskService;
  notifications: NotificationService;
  approvals: ApprovalService;
  knowledge: KnowledgeService;
  browser: BrowserSessions | null;
  scheduler: Scheduler;
  bus: EventBus;
  audit: AuditFn;
  verifier: TokenVerifier;
  /** Creates Firebase accounts for invited users. */
  directory: UserDirectory | null;
  box: SecretBox;
  config: {
    corsOrigins: string[];
    superAdminEmails: string[];
    rateLimitPerMinute: number;
    webhookRateLimitPerMinute: number;
    webhookMaxBodyBytes: number;
    trustProxy: boolean;
    nodeEnv: string;
    publicBaseUrl: string;
    cronSecret: string | null;
    cronCatchUpMs: number;
    cronWaitMs: number;
    /** Keep webhook calls open until their run ends (Vercel without Redis), in ms. 0 = off. */
    webhookWaitMs: number;
  };
  startedAt: number;
  /** Stops queues, schedulers and Redis connections. */
  shutdown(): Promise<void>;
}
