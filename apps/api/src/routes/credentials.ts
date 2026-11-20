import { Router } from 'express';
import { z } from 'zod';
import { AI_SERVICES, hasPermission } from '@widebed/shared';
import type { AppContext } from '../context.js';
import { ah } from '../middleware/errors.js';
import { forbidden } from '../lib/http-error.js';

const name = z.string().trim().min(1).max(80);
const department = z.string().trim().max(80).nullable().default(null);
const collections = z.array(z.string().max(300)).max(50);

/**
 * /api/credentials — connections to outside systems.
 * Listing (for the node "Connection" picker) is open to workflow editors and
 * returns metadata only. Creating, testing and deleting need credential.manage.
 */
export function credentialsRouter(ctx: AppContext) {
  const r = Router();
  const svc = ctx.credentials;
  const manage = (req: { user?: any }) => {
    if (!hasPermission(req.user, 'credential.manage')) throw forbidden('Only IT Admins and Super Admins manage connections');
  };

  r.get('/', ah(async (req, res) => {
    const items = await svc.listVisible(req.user!);
    res.json({ items, google: { configured: svc.googleConfigured, redirectUri: svc.googleRedirectUri } });
  }));

  r.post('/firebase', ah(async (req, res) => {
    manage(req);
    const body = z
      .object({ name, department, serviceAccountJson: z.string().min(10).max(20_000), allowedCollections: collections, readOnly: z.boolean().default(false) })
      .parse(req.body);
    const c = await svc.createFirebase(req.user!, body);
    await ctx.audit({ actorId: req.user!.uid, action: 'credential.create', resourceType: 'credential', resourceId: c.credentialId, metadata: { provider: c.provider, projectId: c.details.projectId } });
    res.status(201).json(c);
  }));

  r.post('/ai', ah(async (req, res) => {
    manage(req);
    const body = z
      .object({ name, department, service: z.enum(AI_SERVICES), model: z.string().trim().max(100).default(''), apiKey: z.string().trim().min(10, 'Paste the API key').max(500) })
      .parse(req.body);
    const c = await svc.createAi(req.user!, body);
    await ctx.audit({ actorId: req.user!.uid, action: 'credential.create', resourceType: 'credential', resourceId: c.credentialId, metadata: { provider: c.provider, service: body.service, model: c.details.model } });
    res.status(201).json(c);
  }));

  const selectors = z.object({ username: z.string().max(200).optional(), password: z.string().max(200).optional(), submit: z.string().max(200).optional() }).optional();
  r.post('/website', ah(async (req, res) => {
    manage(req);
    const body = z
      .object({
        name,
        department,
        loginUrl: z.string().trim().min(8).max(500),
        allowedDomains: z.array(z.string().max(200)).max(10).default([]),
        username: z.string().trim().min(1, 'Enter the username').max(200),
        password: z.string().min(1, 'Enter the password').max(500),
        selectors,
      })
      .parse(req.body);
    const c = await svc.createWebsiteLogin(req.user!, body);
    await ctx.audit({ actorId: req.user!.uid, action: 'credential.create', resourceType: 'credential', resourceId: c.credentialId, metadata: { provider: c.provider, loginUrl: c.details.loginUrl } });
    res.status(201).json(c);
  }));

  r.post('/api-key', ah(async (req, res) => {
    manage(req);
    const body = z
      .object({
        name,
        department,
        headerName: z.string().trim().max(64).default('Authorization'),
        value: z.string().min(1, 'Paste the key or token').max(4000),
        allowedDomains: z.array(z.string().max(200)).max(10).default([]),
      })
      .parse(req.body);
    const c = await svc.createApiKey(req.user!, body);
    await ctx.audit({ actorId: req.user!.uid, action: 'credential.create', resourceType: 'credential', resourceId: c.credentialId, metadata: { provider: c.provider, allowedDomains: c.details.allowedDomains } });
    res.status(201).json(c);
  }));

  r.post('/event-source', ah(async (req, res) => {
    manage(req);
    const body = z.object({ name }).parse(req.body);
    const { credential, key } = await svc.createEventSource(req.user!, body.name);
    await ctx.audit({ actorId: req.user!.uid, action: 'credential.create', resourceType: 'credential', resourceId: credential.credentialId, metadata: { provider: credential.provider } });
    // The key is shown once; only its hash is stored.
    res.status(201).json({ credential, key });
  }));

  r.post('/google/start', ah(async (req, res) => {
    manage(req);
    const body = z.object({ name, department, reconnectId: z.string().max(100).nullish() }).parse(req.body);
    if (body.reconnectId) await svc.getForUser(req.user!, body.reconnectId); // must be visible to this user
    res.json({ url: await svc.startGoogle(req.user!, body) });
  }));

  r.post('/:id/test', ah(async (req, res) => {
    manage(req);
    await svc.getForUser(req.user!, req.params.id);
    res.json(await svc.test(req.params.id));
  }));

  r.patch('/:id', ah(async (req, res) => {
    manage(req);
    const c = await svc.getForUser(req.user!, req.params.id);
    const body = z
      .object({
        name: name.optional(),
        department: department.optional(),
        allowedCollections: collections.optional(),
        readOnly: z.boolean().optional(),
        model: z.string().trim().max(100).optional(),
        apiKey: z.string().trim().max(500).optional(),
        loginUrl: z.string().trim().max(500).optional(),
        allowedDomains: z.array(z.string().max(200)).max(10).optional(),
        username: z.string().trim().max(200).optional(),
        password: z.string().max(500).optional(),
        selectors,
        headerName: z.string().trim().max(64).optional(),
        value: z.string().max(4000).optional(),
      })
      .parse(req.body);
    if (c.provider === 'api_key' && (body.headerName || body.value || body.allowedDomains)) {
      await svc.updateApiKey(c.credentialId, { headerName: body.headerName, value: body.value, allowedDomains: body.allowedDomains });
    }
    if (c.provider === 'website_login' && (body.loginUrl || body.allowedDomains || body.username || body.password || body.selectors)) {
      await svc.updateWebsiteLogin(c.credentialId, { loginUrl: body.loginUrl, allowedDomains: body.allowedDomains, username: body.username, password: body.password, selectors: body.selectors });
    }
    if (c.provider === 'ai_provider' && (body.model || body.apiKey)) await svc.updateAi(c.credentialId, { model: body.model, apiKey: body.apiKey });
    if (body.allowedCollections || body.readOnly !== undefined) {
      await svc.updateFirebaseAccess(c.credentialId, body.allowedCollections ?? c.details.allowedCollections ?? [], body.readOnly ?? !!c.details.readOnly);
    }
    if (body.name || body.department !== undefined) {
      await ctx.repos.credentials.update(c.credentialId, { ...(body.name ? { name: body.name } : {}), ...(body.department !== undefined ? { department: body.department } : {}) });
    }
    await ctx.audit({ actorId: req.user!.uid, action: 'credential.update', resourceType: 'credential', resourceId: c.credentialId, metadata: { fields: Object.keys(body).filter((k) => k !== 'apiKey' && k !== 'password' && k !== 'value').concat(body.apiKey ? ['apiKey (replaced)'] : [], body.password ? ['password (replaced)'] : [], body.value ? ['value (replaced)'] : []) } });
    res.json(await ctx.repos.credentials.get(c.credentialId));
  }));

  r.post('/:id/rotate', ah(async (req, res) => {
    manage(req);
    await svc.getForUser(req.user!, req.params.id);
    const key = await svc.rotateEventSource(req.params.id);
    await ctx.audit({ actorId: req.user!.uid, action: 'credential.rotate', resourceType: 'credential', resourceId: req.params.id });
    res.json({ key });
  }));

  r.delete('/:id', ah(async (req, res) => {
    manage(req);
    const c = await svc.getForUser(req.user!, req.params.id);
    await svc.remove(c.credentialId);
    await ctx.audit({ actorId: req.user!.uid, action: 'credential.delete', resourceType: 'credential', resourceId: c.credentialId, metadata: { name: c.name } });
    res.status(204).end();
  }));

  return r;
}

/** GET /oauth/google/callback — Google redirects the browser here (no API token on this request). */
export function oauthRouter(ctx: AppContext) {
  const r = Router();
  r.get('/google/callback', async (req, res) => {
    const back = (q: string) => res.redirect(302, `/credentials?${q}`);
    if (req.query.error) return back(`error=${encodeURIComponent(String(req.query.error))}`);
    try {
      const c = await ctx.credentials.finishGoogle(String(req.query.code ?? ''), String(req.query.state ?? ''));
      await ctx.audit({ actorId: c.ownerId, action: 'credential.create', resourceType: 'credential', resourceId: c.credentialId, metadata: { provider: c.provider, account: c.details.accountEmail } });
      back(`connected=${encodeURIComponent(c.name)}`);
    } catch (err) {
      back(`error=${encodeURIComponent((err as Error).message)}`);
    }
  });
  return r;
}
