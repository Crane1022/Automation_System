import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ah } from '../middleware/errors.js';
import { PerformanceService } from '../services/performance.js';

/** /api/ai-performance — success rate, time, tokens and cost of AI staff (Admins; department managers: their department). */
export function performanceRouter(ctx: AppContext) {
  const r = Router();
  const svc = new PerformanceService(ctx.repos);

  r.get('/', ah(async (req, res) => {
    const days = z.coerce.number().int().refine((d) => [1, 7, 30, 90].includes(d)).default(30).parse(req.query.days ?? 30);
    res.json(await svc.report(req.user!, days));
  }));

  r.put('/prices', ah(async (req, res) => {
    const body = z
      .object({ prices: z.array(z.object({ model: z.string().max(120), inputPerMillion: z.number().min(0).max(10_000), outputPerMillion: z.number().min(0).max(10_000) })).max(100) })
      .parse(req.body);
    const prices = await svc.setPrices(req.user!, body.prices);
    await ctx.audit({ actorId: req.user!.uid, action: 'ai.prices', resourceType: 'settings', resourceId: 'aiPrices', metadata: { count: prices.length } });
    res.json({ prices });
  }));

  return r;
}
