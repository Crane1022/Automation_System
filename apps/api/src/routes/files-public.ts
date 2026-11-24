import { Router } from 'express';
import type { AppContext } from '../context.js';
import { ah } from '../middleware/errors.js';
import { rateLimit } from '../middleware/rate-limit.js';

/**
 * Public links of workflow files: GET /api/files/<fileId>
 * (photos sent to a webhook, pictures made by the AI Picture step).
 * The id is unguessable and the file expires after FILE_RETENTION_DAYS, so no login is needed.
 * Only pictures and PDFs are ever stored, and they are sent with nosniff so a browser never runs them.
 */
export function publicFilesRouter(ctx: AppContext) {
  const r = Router();
  r.get(
    '/:fileId',
    rateLimit({ windowMs: 60_000, max: Math.max(60, ctx.config.webhookRateLimitPerMinute * 2), key: (req) => `file:${req.ip}` }),
    ah(async (req, res) => {
      const f = await ctx.files.read(String(req.params.fileId));
      if (!f) return res.status(404).json({ error: 'This file does not exist or has expired.' });
      res.setHeader('Content-Type', f.meta.mimeType);
      res.setHeader('Content-Length', String(f.data.length));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
      res.setHeader('Content-Disposition', `inline; filename="${f.meta.name.replace(/"/g, '')}"`);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.status(200).end(f.data);
    }),
  );
  return r;
}
