import crypto from 'node:crypto';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { ah } from '../middleware/errors.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { runDueSchedules } from '../services/schedule-tick.js';

function sameSecret(given: string, expected: string) {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * GET or POST /cron/run-schedules — starts the schedules that are due (see schedule-tick.ts).
 * No Firebase login: the caller proves itself with CRON_SECRET, either as
 *   Authorization: Bearer <secret>   (Vercel Cron sends this) or
 *   ?key=<secret>                    (easiest in cron-job.org).
 * Without CRON_SECRET the link is turned off (404). A wrong secret also gets 404.
 */
export function cronRouter(ctx: AppContext) {
  const r = Router();
  const notFound = { error: 'Not found' };

  const handler = ah(async (req, res) => {
    const secret = ctx.config.cronSecret;
    const auth = req.header('authorization') ?? '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : typeof req.query.key === 'string' ? req.query.key : '';
    if (!secret || !given || !sameSecret(given, secret)) return res.status(404).json(notFound);

    const result = await runDueSchedules(ctx, { catchUpMs: ctx.config.cronCatchUpMs, waitMs: ctx.config.cronWaitMs });
    if (result.runs.length || result.errors.length) console.log('[cron] run-schedules', JSON.stringify(result));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: result.errors.length === 0, ...result });
  });

  const limit = rateLimit({ windowMs: 60_000, max: 30, key: (req) => `cron:${req.ip}` });
  r.get('/run-schedules', limit, handler);
  r.post('/run-schedules', limit, handler);
  return r;
}
