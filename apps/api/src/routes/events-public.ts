import express, { Router } from 'express';
import type { AppContext } from '../context.js';
import { ah } from '../middleware/errors.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { EVENT_NAME } from '@widebed/nodes';

/**
 * POST /events/:eventName — internal apps (PMS, TMS…) report something happened.
 * Authorization: Bearer <event source key>. Every ACTIVE workflow whose published
 * version has an HTTP Event Trigger for this name starts one execution.
 */
export function publicEventsRouter(ctx: AppContext) {
  const r = Router();
  r.post(
    '/:eventName',
    rateLimit({ windowMs: 60_000, max: ctx.config.webhookRateLimitPerMinute * 5 }),
    express.json({ limit: ctx.config.webhookMaxBodyBytes }),
    ah(async (req, res) => {
      const auth = req.header('authorization') ?? '';
      const source = auth.startsWith('Bearer ') ? await ctx.credentials.findEventSource(auth.slice(7).trim()) : null;
      if (!source) return res.status(401).json({ error: 'Invalid or missing event source key' });

      const eventName = req.params.eventName.toLowerCase();
      if (!EVENT_NAME.test(eventName)) return res.status(400).json({ error: 'Invalid event name' });

      const idempotencyKey = req.header('idempotency-key')?.slice(0, 200) || null;
      const receivedAt = new Date().toISOString();
      const workflows = await ctx.repos.workflows.listActiveByEvent(eventName, 100);
      const started: { workflowId: string; executionId: string; deduplicated: boolean }[] = [];
      for (const wf of workflows) {
        const version = wf.publishedVersionId ? await ctx.repos.versions.get(wf.publishedVersionId) : null;
        const node = version?.nodes.find((n) => n.type === 'trigger.event' && !n.disabled && n.config.eventName === eventName);
        if (!node) continue;
        try {
          const result = await ctx.executions.start({
            workflow: wf,
            mode: 'published',
            triggerType: 'http_event',
            triggerNodeId: node.id,
            triggerItems: [{ json: { event: eventName, source: source.name, data: req.body ?? {}, receivedAt } }],
            initiatedBy: null,
            idempotencyKey: idempotencyKey ? `${eventName}:${idempotencyKey}` : null,
          });
          started.push({ workflowId: wf.workflowId, ...result });
        } catch (err) {
          console.error(`[events] could not start ${wf.workflowId} for ${eventName}:`, (err as Error).message);
        }
      }
      res.status(202).json({ event: eventName, started });
    }),
  );
  return r;
}
