import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/http-error.js';
import { QueueFullError, QueueUnavailableError } from '../services/queue.js';

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Invalid request',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof QueueFullError || err instanceof QueueUnavailableError) {
    return res.status(503).json({ error: err.message });
  }
  if ((err as any)?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  if ((err as any)?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  // Firestore index missing or still being built (FAILED_PRECONDITION, code 9).
  const e = err as { code?: unknown; message?: unknown };
  if ((e?.code === 9 || e?.code === 'failed-precondition') && /index/i.test(String(e?.message ?? ''))) {
    const link = /https:\/\/console\.firebase\.google\.com\S+/.exec(String(e.message))?.[0];
    console.error(
      `[api] ${req.method} ${req.path}: Firestore index missing or still building.` +
        (link ? `\n      Open this link to see it (or create it with one click): ${link}` : `\n      ${String(e.message).split('\n')[0]}`),
    );
    return res.status(503).json({
      error: 'The database is still preparing for this page (a Firestore index). If you just updated, wait a few minutes and try again. IT: run “npx firebase-tools deploy --only firestore”.',
    });
  }
  // Unknown error: log details server-side, return a generic message.
  console.error(`[api] ${req.method} ${req.path} failed`, err);
  res.status(500).json({ error: 'Internal server error' });
}

/** Wraps async route handlers so thrown errors reach errorHandler. */
export const ah =
  <T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(fn: T) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
