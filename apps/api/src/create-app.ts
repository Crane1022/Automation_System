import express from 'express';
import cors from 'cors';
import type { AppContext } from './context.js';
import { createAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/errors.js';
import { rateLimit } from './middleware/rate-limit.js';
import { workflowsRouter } from './routes/workflows.js';
import { customStepsRouter } from './routes/custom-steps.js';
import { executionsRouter } from './routes/executions.js';
import { publicWebhookRouter } from './routes/webhooks-public.js';
import { publicFilesRouter } from './routes/files-public.js';
import { publicEventsRouter } from './routes/events-public.js';
import { cronRouter } from './routes/cron-public.js';
import { credentialsRouter, oauthRouter } from './routes/credentials.js';
import { templatesRouter } from './routes/templates.js';
import { assistantRouter } from './routes/assistant.js';
import { agentsRouter } from './routes/agents.js';
import { approvalsRouter } from './routes/approvals.js';
import { knowledgeRouter } from './routes/knowledge.js';
import { performanceRouter } from './routes/performance.js';
import { agentProjectsRouter, agentResponsibilitiesRouter, agentSchedulesRouter, agentTasksRouter, notificationsRouter } from './routes/agent-tasks.js';
import { dashboardRouter, foldersRouter, meRouter, peopleRouter, nodeTypesRouter, schedulesRouter, systemRouter, usersRouter } from './routes/misc.js';

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable('x-powered-by');
  if (ctx.config.trustProxy) app.set('trust proxy', 1);

  // Basic security headers (the reverse proxy adds HSTS).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Public, unauthenticated routes.
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.use('/hooks', publicWebhookRouter(ctx));
  // Same webhooks under /api/hooks: hosting that only forwards /api/* to the API (e.g. some Vercel
  // setups answer /hooks/* themselves with 405) still reaches them. Mounted before the /api auth.
  app.use('/api/hooks', publicWebhookRouter(ctx));
  // Links of webhook uploads and AI pictures (e.g. the room preview a chat box shows).
  app.use('/api/files', publicFilesRouter(ctx));
  app.use('/events', publicEventsRouter(ctx));
  app.use('/oauth', oauthRouter(ctx));
  app.use('/cron', cronRouter(ctx));

  // Authenticated JSON API.
  const { authenticate, invalidate } = createAuth({
    verifier: ctx.verifier,
    users: ctx.repos.users,
    superAdminEmails: ctx.config.superAdminEmails,
  });
  const api = express.Router();
  api.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || ctx.config.corsOrigins.includes(origin)),
      allowedHeaders: ['Authorization', 'Content-Type'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      maxAge: 600,
    }),
  );
  api.use(rateLimit({ windowMs: 60_000, max: ctx.config.rateLimitPerMinute }));
  api.use(express.json({ limit: '2mb' }));
  api.use(authenticate);
  api.use('/me', meRouter(ctx));
  api.use('/users', usersRouter(ctx, invalidate));
  api.use('/workflows', workflowsRouter(ctx));
  api.use('/custom-steps', customStepsRouter(ctx));
  api.use('/folders', foldersRouter(ctx));
  api.use('/people', peopleRouter(ctx));
  api.use('/templates', templatesRouter(ctx));
  api.use('/assistant', assistantRouter(ctx));
  api.use('/agents', agentsRouter(ctx));
  api.use('/agent-tasks', agentTasksRouter(ctx));
  api.use('/agent-schedules', agentSchedulesRouter(ctx));
  api.use('/agent-responsibilities', agentResponsibilitiesRouter(ctx));
  api.use('/notifications', notificationsRouter(ctx));
  api.use('/approvals', approvalsRouter(ctx));
  api.use('/agent-projects', agentProjectsRouter(ctx));
  api.use('/knowledge', knowledgeRouter(ctx));
  api.use('/ai-performance', performanceRouter(ctx));
  api.use('/executions', executionsRouter(ctx));
  api.use('/node-types', nodeTypesRouter(ctx));
  api.use('/credentials', credentialsRouter(ctx));
  api.use('/schedules', schedulesRouter(ctx));
  api.use('/dashboard', dashboardRouter(ctx));
  api.use('/system', systemRouter(ctx));
  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  app.use(errorHandler);
  return app;
}
