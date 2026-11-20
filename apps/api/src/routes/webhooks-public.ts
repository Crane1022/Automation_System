import express, { Router } from 'express';
import { TERMINAL_STATUSES } from '@widebed/shared';
import type { AppContext } from '../context.js';
import { ah } from '../middleware/errors.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { verifyHmac } from '../lib/crypto.js';

/** Headers that are never forwarded into workflow data. */
const DROP_HEADERS = /^(authorization|cookie|proxy-authorization|x-widebed-signature|x-forwarded-.*|x-real-ip|forwarded)$/i;

/**
 * Public webhook receiver: ANY /hooks/:token
 * No Firebase login — the unguessable token (and optional HMAC) authenticate the caller.
 * Every failure returns the same 404 so callers cannot probe which tokens exist.
 */
export function publicWebhookRouter(ctx: AppContext) {
  const r = Router();
  const notFound = { error: 'Not found' };

  r.all(
    '/:token',
    rateLimit({ windowMs: 60_000, max: ctx.config.webhookRateLimitPerMinute, key: (req) => `${req.ip}:${req.params.token?.slice(0, 8)}` }),
    // Keep the raw bytes: the HMAC must be computed on exactly what was sent.
    express.raw({ type: () => true, limit: ctx.config.webhookMaxBodyBytes }),
    ah(async (req, res) => {
      const ep = await ctx.webhooks.resolve(req.params.token);
      if (!ep) return res.status(404).json(notFound);

      const wf = await ctx.repos.workflows.get(ep.workflowId);
      if (!wf || wf.status !== 'active' || !wf.publishedVersionId) return res.status(404).json(notFound);
      const version = await ctx.repos.versions.get(wf.publishedVersionId);
      const node = version?.nodes.find((n) => n.id === ep.nodeId);
      if (!node) return res.status(404).json(notFound);

      const method = String(node.config.method ?? 'POST');
      if (req.method !== method) return res.status(405).json({ error: `Use ${method}` });

      const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (node.config.requireSignature === true) {
        const ok = verifyHmac(ctx.webhooks.signingSecret(ep), raw, req.header('x-widebed-signature'));
        if (!ok) return res.status(401).json({ error: 'Invalid signature' });
      }

      let body: unknown = null;
      const text = raw.toString('utf8');
      if (text) {
        const type = req.header('content-type') ?? '';
        if (type.includes('json')) {
          try {
            body = JSON.parse(text);
          } catch {
            return res.status(400).json({ error: 'Body is not valid JSON' });
          }
        } else if (type.includes('application/x-www-form-urlencoded')) {
          body = Object.fromEntries(new URLSearchParams(text));
        } else {
          body = text;
        }
      }
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !DROP_HEADERS.test(k)));

      const idempotencyKey = req.header('idempotency-key')?.slice(0, 200) || null;
      const result = await ctx.executions.start({
        workflow: wf,
        mode: 'published',
        triggerType: 'webhook',
        triggerNodeId: node.id,
        triggerItems: [{ json: { body, query: req.query as Record<string, unknown>, headers, method: req.method } }],
        initiatedBy: null,
        idempotencyKey,
      });
      // On Vercel without Redis the run happens inside this function, and Vercel pauses the function
      // once it has answered. Keep the call open until the run ends (or the wait limit is reached).
      const waitMs = ctx.config.webhookWaitMs;
      if (waitMs > 0 && !result.deduplicated && ctx.executions.queue.mode === 'in-process') {
        const until = Date.now() + waitMs;
        while (Date.now() < until) {
          const exec = await ctx.repos.executions.get(result.executionId);
          if (!exec || TERMINAL_STATUSES.includes(exec.status)) break;
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      res.status(202).json({ executionId: result.executionId, deduplicated: result.deduplicated });
    }),
  );
  return r;
}
