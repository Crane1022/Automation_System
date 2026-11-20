import express, { Router } from 'express';
import { TERMINAL_STATUSES } from '@widebed/shared';
import { parseOrigins } from '@widebed/nodes';
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

  /** The webhook node behind a token, if its workflow is active. */
  async function endpointNode(token: string) {
    const ep = await ctx.webhooks.resolve(token);
    if (!ep) return null;
    const wf = await ctx.repos.workflows.get(ep.workflowId);
    if (!wf || wf.status !== 'active' || !wf.publishedVersionId) return null;
    const version = await ctx.repos.versions.get(wf.publishedVersionId);
    const node = version?.nodes.find((n) => n.id === ep.nodeId);
    return node ? { ep, wf, node } : null;
  }
  /** Websites (browser chat boxes) allowed by the webhook step. */
  const originsOf = (node: { config: Record<string, unknown> }) => parseOrigins(String(node.config.allowedOrigins ?? '')) ?? [];
  const originAllowed = (node: { config: Record<string, unknown> }, origin: string) => {
    const list = originsOf(node);
    return list.includes('*') || list.includes(origin);
  };

  // Browsers ask first ("preflight") before a chat box on another website may send JSON.
  // originAllowed() is checked on the real call below.
  r.options(
    '/:token',
    rateLimit({ windowMs: 60_000, max: ctx.config.webhookRateLimitPerMinute, key: (req) => `${req.ip}:${req.params.token?.slice(0, 8)}` }),
    ah(async (req, res) => {
      const found = await endpointNode(req.params.token);
      const origin = req.header('origin');
      // A website that is not listed may still ask: its real call is then refused with a message
      // saying which address to add (nothing runs). Unknown tokens stay 404.
      if (!found || !origin) return res.status(404).json(notFound);
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', String(found.node.config.method ?? 'POST'));
      res.setHeader('Access-Control-Allow-Headers', 'content-type, idempotency-key');
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
    }),
  );

  r.all(
    '/:token',
    rateLimit({ windowMs: 60_000, max: ctx.config.webhookRateLimitPerMinute, key: (req) => `${req.ip}:${req.params.token?.slice(0, 8)}` }),
    // Keep the raw bytes: the HMAC must be computed on exactly what was sent.
    express.raw({ type: () => true, limit: ctx.config.webhookMaxBodyBytes }),
    ah(async (req, res) => {
      const found = await endpointNode(req.params.token);
      if (!found) return res.status(404).json(notFound);
      const { ep, wf, node } = found;

      // Calls from a web page carry an Origin header: only the listed websites may use this webhook.
      const origin = req.header('origin');
      if (origin) {
        if (!originAllowed(node, origin)) {
          // Say which address to add (browsers can only read this if the site is allowed, so also log it).
          res.setHeader('Access-Control-Allow-Origin', origin);
          return res.status(403).json({ error: `This website (${origin}) is not allowed yet. In the Webhook step, add it to “Websites that may call it”.` });
        }
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }

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
      // "Wait and send back the reply": wait for the run, then answer with what its Respond step set.
      if (node.config.responseMode === 'reply') {
        const until = Date.now() + ctx.config.webhookReplyMs;
        let exec = await ctx.repos.executions.get(result.executionId);
        while (exec && !TERMINAL_STATUSES.includes(exec.status) && !exec.webhookResponseJson && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 300));
          exec = await ctx.repos.executions.get(result.executionId);
        }
        // On Vercel without Redis, keep the function alive until the rest of the run has finished too.
        if (exec && ctx.config.webhookWaitMs > 0 && ctx.executions.queue.mode === 'in-process') {
          const stop = Date.now() + ctx.config.webhookWaitMs;
          while (exec && !TERMINAL_STATUSES.includes(exec.status) && Date.now() < stop) {
            await new Promise((r) => setTimeout(r, 400));
            exec = await ctx.repos.executions.get(result.executionId);
          }
        }
        if (exec?.webhookResponseJson) {
          const answer = JSON.parse(exec.webhookResponseJson) as { status: number; body: unknown; contentType: 'json' | 'text' };
          res.status(answer.status);
          return answer.contentType === 'text' ? res.type('text/plain').send(String(answer.body ?? '')) : res.json(answer.body ?? {});
        }
        if (!exec || exec.status === 'failed' || exec.status === 'cancelled') return res.status(500).json({ error: 'The workflow could not answer. See Executions for details.', executionId: result.executionId });
        if (!TERMINAL_STATUSES.includes(exec.status)) return res.status(202).json({ executionId: result.executionId, status: exec.status, error: 'Still working — no answer yet.' });
        return res.status(200).json({ ok: true, executionId: result.executionId });
      }

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
