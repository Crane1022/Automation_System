import { createDefaultRegistry, createSafeHttpClient } from '@widebed/nodes';
import type { AppContext } from './context.js';
import type { Config } from './config.js';
import type { Repositories } from './repositories/types.js';
import type { TokenVerifier } from './auth/verifier.js';
import type { UserDirectory } from './auth/user-directory.js';
import { SecretBox } from './lib/crypto.js';
import { createLocalEventBus, createRedisEventBus } from './services/event-bus.js';
import { BullExecutionQueue, InProcessQueue } from './services/queue.js';
import { BullScheduler, InProcessScheduler } from './services/scheduler.js';
import { ExecutionService } from './services/execution-service.js';
import { WebhookService } from './services/webhook-service.js';
import { CredentialService, type CredentialServiceOptions } from './services/credential-service.js';
import { createCodeSandbox } from './services/code-sandbox.js';
import { createAuditLogger } from './services/audit.js';
import { AssistantService } from './assistant/service.js';
import { SystemService } from './services/system-service.js';
import { AI_SCHEDULE_PREFIX, AgentTaskService } from './assistant/tasks.js';
import { NotificationService } from './services/notifications.js';
import { ApprovalService } from './assistant/approvals.js';
import { BrowserSessions, playwrightLauncher, type BrowserLauncher } from './assistant/browser.js';

export interface BuildOptions {
  directory?: UserDirectory | null;
  /** Test hooks for the credential service (fake Google / Firestore). */
  credentialOverrides?: Partial<CredentialServiceOptions>;
  /** Test hook: a fake browser instead of Playwright. */
  browserLauncher?: BrowserLauncher;
  /** Test hook: how long the assistant waits for a workflow it ran. */
  assistantWorkflowWait?: { waitMs?: number; pollMs?: number };
  /** Tests: wait before an AI task is retried automatically. */
  agentRetryDelayMs?: number;
}

/**
 * Wires all services together. Used by server.ts, worker.ts and the tests.
 * With REDIS_URL: BullMQ queue + scheduler + Redis pub/sub.
 * Without: everything in this process (development / tests).
 */
export function buildContext(config: Config, repos: Repositories, verifier: TokenVerifier, opts: BuildOptions = {}): AppContext {
  const registry = createDefaultRegistry();
  const box = new SecretBox(config.ENCRYPTION_KEY);
  const redis = config.REDIS_URL ? { url: config.REDIS_URL } : null;
  const connection = redis ? { url: redis.url, maxRetriesPerRequest: null } : null;

  const bus = redis ? createRedisEventBus(redis.url) : createLocalEventBus();
  const queue = connection
    ? new BullExecutionQueue(connection, config.EXECUTION_CONCURRENCY, config.MAX_QUEUE_LENGTH)
    : new InProcessQueue(config.EXECUTION_CONCURRENCY, config.MAX_QUEUE_LENGTH);
  const scheduler = connection ? new BullScheduler(connection) : new InProcessScheduler();

  const http = createSafeHttpClient({
    allowPrivateNetworks: config.HTTP_ALLOW_PRIVATE_NETWORKS,
    allowedPrivateHosts: config.HTTP_ALLOWED_PRIVATE_HOSTS,
    maxResponseBytes: config.HTTP_MAX_RESPONSE_BYTES,
    maxRedirects: 5,
    defaultTimeoutMs: 15000,
  });
  const credentials = new CredentialService({
    repos,
    box,
    encryptionKey: config.ENCRYPTION_KEY,
    ownProjectId: config.FIREBASE_PROJECT_ID,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    google: config.GOOGLE_OAUTH_CLIENT_ID && config.GOOGLE_OAUTH_CLIENT_SECRET ? { clientId: config.GOOGLE_OAUTH_CLIENT_ID, clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET } : undefined,
    ...opts.credentialOverrides,
  });
  const executions = new ExecutionService({
    repos,
    registry,
    bus,
    queue,
    http,
    credentials,
    runCode: createCodeSandbox({ memoryMb: config.CODE_MAX_MEMORY_MB, timezone: config.CODE_TIMEZONE }),
    timeoutMs: config.EXECUTION_TIMEOUT_MS,
    waitMaxMs: config.WAIT_MAX_MS,
  });

  const browser = config.ASSISTANT_BROWSER ? new BrowserSessions(opts.browserLauncher ?? playwrightLauncher(), config.ASSISTANT_FILES_DIR) : null;
  const assistant = new AssistantService({ repos, credentials, executions, browser, workflowWait: opts.assistantWorkflowWait });
  // AI Agent workflow steps run the assistant as the workflow's owner.
  executions.setAgentRunner(async (exec, req) => {
    const wf = await repos.workflows.get(exec.workflowId);
    const owner = wf ? await repos.users.get(wf.ownerId) : null;
    if (!owner || owner.status !== 'active') throw new Error('The workflow’s owner is not an active user, so the AI Agent cannot act for them');
    let agentId: string | undefined;
    if (req.agent) {
      const want = req.agent.toLowerCase();
      const found = (await assistant.agents.listAll()).find((a) => a.agentId === req.agent || a.name.toLowerCase() === want);
      if (!found) throw new Error(`There is no AI employee called “${req.agent}” (check the name on the AI Staff page)`);
      agentId = found.agentId;
    }
    return assistant.runHeadless(owner, { ...req, agentId });
  });

  // AI Staff background tasks have their own queue, so long AI jobs never hold up workflow runs.
  const agentQueue = connection
    ? new BullExecutionQueue(connection, config.AI_TASK_CONCURRENCY, config.MAX_QUEUE_LENGTH, 'wb-agent-tasks')
    : new InProcessQueue(config.AI_TASK_CONCURRENCY, config.MAX_QUEUE_LENGTH);
  const notifications = new NotificationService(repos);
  const system = new SystemService({ repos, credentials, publicBaseUrl: config.PUBLIC_BASE_URL, webBaseUrl: config.CORS_ORIGINS[0] });
  const approvals = new ApprovalService({ repos, agents: assistant.agents, notifications, settings: () => system.settings() });
  assistant.useApprovals(approvals);
  const agentTasks = new AgentTaskService({ repos, assistant, queue: agentQueue, scheduler, bus, notifications, approvals, timeoutMs: config.AI_TASK_TIMEOUT_MS, retryDelayMs: opts.agentRetryDelayMs });

  executions.onFailure((id) => system.onRunFailed(id));

  return {
    repos,
    registry,
    executions,
    assistant,
    agentTasks,
    notifications,
    approvals,
    knowledge: assistant.knowledge,
    system,
    browser,
    webhooks: new WebhookService(repos, registry, box, config.PUBLIC_BASE_URL),
    credentials,
    scheduler,
    bus,
    audit: createAuditLogger(repos.audit),
    verifier,
    directory: opts.directory ?? null,
    box,
    config: {
      corsOrigins: config.CORS_ORIGINS,
      superAdminEmails: config.SUPER_ADMIN_EMAILS,
      rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
      webhookRateLimitPerMinute: config.WEBHOOK_RATE_LIMIT_PER_MINUTE,
      webhookMaxBodyBytes: config.WEBHOOK_MAX_BODY_BYTES,
      trustProxy: config.TRUST_PROXY,
      nodeEnv: config.NODE_ENV,
      publicBaseUrl: config.PUBLIC_BASE_URL,
    },
    startedAt: Date.now(),
    async shutdown() {
      await Promise.allSettled([queue.close(), agentQueue.close(), scheduler.close(), browser?.shutdown()]);
      await bus.close();
    },
  };
}

/** Starts job processing (executions + schedules) in this process. */
export function startProcessing(ctx: AppContext) {
  ctx.executions.startWorker();
  ctx.agentTasks.startWorker();
  ctx.scheduler.startProcessing(async (wf, node, at, key) => {
    // AI Staff schedules share the scheduler; their ids start with "ai-".
    if (wf.startsWith(AI_SCHEDULE_PREFIX)) await ctx.agentTasks.fire(wf.slice(AI_SCHEDULE_PREFIX.length), at, key);
    else await ctx.executions.fireSchedule(wf, node, at, key);
  });
}

/** Re-registers the schedules of all active workflows (needed for in-process timers after a restart). */
export async function resyncSchedules(ctx: AppContext) {
  const active = await ctx.repos.workflows.listActive(1000);
  for (const wf of active) {
    const version = wf.publishedVersionId ? await ctx.repos.versions.get(wf.publishedVersionId) : null;
    await ctx.scheduler.sync(wf.workflowId, version);
  }
  return active.length + (await ctx.agentTasks.resyncAll());
}
