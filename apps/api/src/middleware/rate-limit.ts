import type { NextFunction, Request, Response } from 'express';

/**
 * Fixed-window rate limiter kept in memory (per API instance).
 * Phase 2 moves the counters to Redis so limits hold across instances.
 */
export function rateLimit(opts: { windowMs: number; max: number; key?: (req: Request) => string }) {
  const hits = new Map<string, { count: number; reset: number }>();
  const keyOf = opts.key ?? ((req: Request) => req.ip ?? 'unknown');

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, opts.windowMs).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const k = keyOf(req);
    let e = hits.get(k);
    if (!e || e.reset <= now) {
      e = { count: 0, reset: now + opts.windowMs };
      hits.set(k, e);
    }
    e.count++;
    res.setHeader('RateLimit-Limit', String(opts.max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, opts.max - e.count)));
    if (e.count > opts.max) {
      res.setHeader('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests, slow down.' });
    }
    next();
  };
}
