import crypto from 'node:crypto';
import { cert, getApp, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, DocumentReference, GeoPoint, type Firestore } from 'firebase-admin/firestore';
import type { AiService, AppUser, Credential } from '@widebed/shared';
import { AI_SERVICE_INFO, collectionAllowed, hasPermission, maskUsername } from '@widebed/shared';
import type { AiRequest, AiResponse, FirestoreAccess, FirestoreDoc } from '@widebed/nodes';
import { aiComplete, aiStream, defaultAiFetch, defaultAiStreamFetch, listAiModels, type AiFetch, type AiStreamFetch } from './ai-client.js';
import { NodeError, buildMime } from '@widebed/nodes';
import type { Repositories } from '../repositories/types.js';
import { SecretBox, hashToken, randomToken } from '../lib/crypto.js';
import { newId, nowIso } from '../lib/ids.js';
import { badRequest, forbidden, notFound } from '../lib/http-error.js';

/** Collections of the automation platform itself — never reachable from Firebase nodes. */
const PLATFORM_COLLECTIONS = new Set([
  'users', 'workflows', 'workflowVersions', 'workflowExecutions', 'workflowFolders', 'workflowTemplates', 'webhookEndpoints',
  'credentials', 'credentialSecrets', 'auditLogs', 'systemSettings',
]);

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/spreadsheets',
];

interface ServiceAccount {
  type: string;
  project_id: string;
  client_email: string;
  private_key: string;
}

type FetchJson = (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; json: any }>;

const defaultFetchJson: FetchJson = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

export interface CredentialServiceOptions {
  /** Injected for tests (AI services). */
  aiFetch?: AiFetch;
  /** Injected for tests (streamed AI answers). If only aiFetch is given, answers are not streamed. */
  aiStreamFetch?: AiStreamFetch;
  repos: Repositories;
  box: SecretBox;
  encryptionKey: string;
  ownProjectId: string;
  publicBaseUrl: string;
  google?: { clientId: string; clientSecret: string };
  /** Injected for tests. */
  connectFirestore?: (sa: ServiceAccount, appName: string) => Firestore;
  fetchJson?: FetchJson;
}

export class CredentialService {
  private stateKey: Buffer;
  private firestores = new Map<string, Firestore>();
  private tokens = new Map<string, { accessToken: string; expiresAt: number; email: string | null }>();
  private fetchJson: FetchJson;
  private aiFetch: AiFetch;
  private aiStreamFetch: AiStreamFetch | null;

  constructor(private o: CredentialServiceOptions) {
    this.stateKey = crypto.createHash('sha256').update(`oauth-state:${o.encryptionKey}`).digest();
    this.fetchJson = o.fetchJson ?? defaultFetchJson;
    this.aiFetch = o.aiFetch ?? defaultAiFetch;
    this.aiStreamFetch = o.aiStreamFetch ?? (o.aiFetch ? null : defaultAiStreamFetch);
  }

  get googleConfigured() {
    return !!this.o.google?.clientId && !!this.o.google?.clientSecret;
  }
  get googleRedirectUri() {
    return `${this.o.publicBaseUrl.replace(/\/$/, '')}/oauth/google/callback`;
  }

  /* ------------------------------------------------------------ visibility */

  /** Who may see / pick a credential in the editor. */
  visibleTo(user: AppUser, c: Credential) {
    return hasPermission(user, 'credential.manage') || c.department === null || c.department === user.department;
  }

  /** Whether a workflow of this department may use the credential at run time. */
  usableBy(c: Credential, department: string | null) {
    return c.department === null || c.department === department;
  }

  async listVisible(user: AppUser) {
    return (await this.o.repos.credentials.list(500)).filter((c) => this.visibleTo(user, c));
  }

  async getForUser(user: AppUser, id: string) {
    const c = await this.o.repos.credentials.get(id);
    if (!c || !this.visibleTo(user, c)) throw notFound('Connection not found');
    return c;
  }

  /* ------------------------------------------------------------ create */

  private async save(user: AppUser, base: Pick<Credential, 'name' | 'provider' | 'department' | 'details'>, secret: unknown, status: Credential['status'] = 'connected') {
    const id = newId('cred');
    const now = nowIso();
    const c: Credential = {
      credentialId: id,
      ...base,
      ownerId: user.uid,
      status,
      encryptedSecretReference: `credentialSecrets/${id}`,
      lastTestedAt: null,
      lastTestResult: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.o.repos.credentialSecrets.set(id, this.o.box.encrypt(JSON.stringify(secret)));
    await this.o.repos.credentials.create(c);
    return c;
  }

  async createFirebase(user: AppUser, input: { name: string; department: string | null; serviceAccountJson: string; allowedCollections: string[]; readOnly: boolean }) {
    let sa: ServiceAccount;
    try {
      sa = JSON.parse(input.serviceAccountJson);
    } catch {
      throw badRequest('The service account file is not valid JSON');
    }
    if (sa?.type !== 'service_account' || !sa.project_id || !sa.client_email || !sa.private_key) {
      throw badRequest('This is not a Firebase service account key (expected type "service_account" with project_id, client_email and private_key)');
    }
    const allowed = normaliseCollections(input.allowedCollections, sa.project_id === this.o.ownProjectId);
    return this.save(
      user,
      {
        name: input.name,
        provider: 'firebase_service_account',
        department: input.department,
        details: { projectId: sa.project_id, clientEmail: sa.client_email, allowedCollections: allowed, readOnly: input.readOnly },
      },
      { serviceAccount: { type: sa.type, project_id: sa.project_id, client_email: sa.client_email, private_key: sa.private_key } },
    );
  }

  /* ------------------------------------------------------------ AI service */

  /** Saves an AI connection after checking the key works with that model. */
  async createAi(user: AppUser, input: { name: string; department: string | null; service: AiService; model: string; apiKey: string }) {
    const apiKey = input.apiKey.trim();
    const model = input.model.trim() || AI_SERVICE_INFO[input.service].defaultModel;
    const check = await this.tryAi(input.service, model, apiKey);
    if (!check.ok) throw badRequest(check.message);
    const c = await this.save(user, { name: input.name, provider: 'ai_provider', department: input.department, details: { aiService: input.service, model, keyEnding: apiKey.slice(-4) } }, { apiKey });
    await this.o.repos.credentials.update(c.credentialId, { lastTestedAt: nowIso(), lastTestResult: check.message });
    return (await this.o.repos.credentials.get(c.credentialId))!;
  }

  /** Change the model and/or replace the API key of an AI connection (checked before saving). */
  async updateAi(id: string, input: { model?: string; apiKey?: string }) {
    const c = await this.o.repos.credentials.get(id);
    if (!c || c.provider !== 'ai_provider') throw notFound('Connection not found');
    const secret = await this.readSecret(id);
    const apiKey = input.apiKey?.trim() || String(secret.apiKey);
    const model = input.model?.trim() || c.details.model || AI_SERVICE_INFO[c.details.aiService ?? 'openai'].defaultModel;
    const check = await this.tryAi(c.details.aiService ?? 'openai', model, apiKey);
    if (!check.ok) throw badRequest(check.message);
    if (input.apiKey?.trim()) await this.o.repos.credentialSecrets.set(id, this.o.box.encrypt(JSON.stringify({ apiKey })));
    await this.o.repos.credentials.update(id, { status: 'connected', details: { ...c.details, model, keyEnding: apiKey.slice(-4) }, lastTestedAt: nowIso(), lastTestResult: check.message, updatedAt: nowIso() });
  }

  private async tryAi(service: AiService, model: string, apiKey: string): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await aiComplete({ service, model, apiKey }, { prompt: 'Reply with the word OK.', maxTokens: 1000 }, this.aiFetch);
      return { ok: true, message: `Connected · ${res.model}` };
    } catch (err: any) {
      return { ok: false, message: err?.message ?? String(err) };
    }
  }

  /**
   * Used by AI nodes and AI staff. `opts` lets an AI employee pick its own model and
   * temperature, and `onText` streams the answer while it is written.
   */
  async ai(id: string, department: string | null, req: AiRequest, opts: { model?: string | null; temperature?: number | null; onText?: (soFar: string) => void } = {}): Promise<AiResponse> {
    const c = await this.loadForRun(id, 'ai_provider', department);
    const { apiKey } = await this.readSecret(id);
    const { signal, ...rest } = req;
    const service = c.details.aiService ?? 'openai';
    const cfg = { service, model: opts.model?.trim() || c.details.model || AI_SERVICE_INFO[service].defaultModel, apiKey, temperature: opts.temperature ?? null };
    if (opts.onText && this.aiStreamFetch) return aiStream(cfg, rest, opts.onText, this.aiStreamFetch, signal);
    const res = await aiComplete(cfg, rest, this.aiFetch, signal);
    opts.onText?.(res.text);
    return res;
  }

  /** Models the key of this AI connection can use (asked from the AI service). */
  async aiModels(id: string) {
    const c = await this.o.repos.credentials.get(id);
    if (!c || c.provider !== 'ai_provider') throw notFound('AI connection not found');
    const { apiKey } = await this.readSecret(id);
    return { service: c.details.aiService ?? 'openai', current: c.details.model ?? null, models: await listAiModels({ service: c.details.aiService ?? 'openai', apiKey: String(apiKey) }, this.aiFetch) };
  }

  /* ------------------------------------------------------------ website logins */

  /** A username + password the assistant's browser may use on one website. Stored encrypted; never shown again. */
  async createWebsiteLogin(
    user: AppUser,
    input: { name: string; department: string | null; loginUrl: string; allowedDomains: string[]; username: string; password: string; selectors?: { username?: string; password?: string; submit?: string } },
  ) {
    const details = websiteDetails(input.loginUrl, input.allowedDomains, input.username, input.selectors);
    return this.save(user, { name: input.name, provider: 'website_login', department: input.department, details }, { username: input.username.trim(), password: input.password });
  }

  async updateWebsiteLogin(id: string, input: { loginUrl?: string; allowedDomains?: string[]; username?: string; password?: string; selectors?: { username?: string; password?: string; submit?: string } }) {
    const c = await this.o.repos.credentials.get(id);
    if (!c || c.provider !== 'website_login') throw notFound('Connection not found');
    const secret = await this.readSecret(id);
    const username = input.username?.trim() || String(secret.username);
    const password = input.password || String(secret.password);
    const details = websiteDetails(input.loginUrl ?? c.details.loginUrl ?? '', input.allowedDomains ?? c.details.allowedDomains ?? [], username, input.selectors ?? c.details.selectors);
    await this.o.repos.credentialSecrets.set(id, this.o.box.encrypt(JSON.stringify({ username, password })));
    await this.o.repos.credentials.update(id, { details, status: 'connected', updatedAt: nowIso() });
  }

  /** For the browser tool only (server side). The AI never receives these values. */
  async websiteLogin(id: string, department: string | null): Promise<{ credential: Credential; username: string; password: string }> {
    const c = await this.loadForRun(id, 'website_login', department);
    const s = await this.readSecret(id);
    return { credential: c, username: String(s.username ?? ''), password: String(s.password ?? '') };
  }

  async createEventSource(user: AppUser, name: string) {
    const key = `wbe_${randomToken(24)}`;
    const c = await this.save(user, { name, provider: 'event_source', department: null, details: { keyPrefix: key.slice(0, 10) } }, { keyHash: hashToken(key) });
    return { credential: c, key };
  }

  async rotateEventSource(id: string) {
    const c = await this.o.repos.credentials.get(id);
    if (!c || c.provider !== 'event_source') throw notFound('Event source not found');
    const key = `wbe_${randomToken(24)}`;
    await this.o.repos.credentialSecrets.set(id, this.o.box.encrypt(JSON.stringify({ keyHash: hashToken(key) })));
    await this.o.repos.credentials.update(id, { details: { keyPrefix: key.slice(0, 10) }, updatedAt: nowIso() });
    return key;
  }

  /** Finds the event source whose key matches (constant-time compare of hashes). */
  async findEventSource(key: string): Promise<Credential | null> {
    if (!/^wbe_[A-Za-z0-9_-]{20,80}$/.test(key)) return null;
    const wanted = Buffer.from(hashToken(key), 'hex');
    for (const c of await this.o.repos.credentials.list(500)) {
      if (c.provider !== 'event_source' || c.status !== 'connected' || !key.startsWith(c.details.keyPrefix ?? '')) continue;
      const secret = await this.readSecret(c.credentialId);
      const have = Buffer.from(String(secret.keyHash ?? ''), 'hex');
      if (have.length === wanted.length && crypto.timingSafeEqual(have, wanted)) return c;
    }
    return null;
  }

  /* ------------------------------------------------------------ Google OAuth */

  /**
   * Starts Google sign-in. With `reconnectId` the existing connection is refreshed in place
   * (new permissions, new token) so workflows that use it keep working.
   */
  async startGoogle(user: AppUser, input: { name: string; department: string | null; reconnectId?: string | null }) {
    if (!this.googleConfigured) throw badRequest('Google sign-in is not configured on the server (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET)');
    let name = input.name;
    let department = input.department;
    if (input.reconnectId) {
      const existing = await this.o.repos.credentials.get(input.reconnectId);
      if (!existing || existing.provider !== 'google_oauth') throw badRequest('That Google connection no longer exists');
      name = existing.name;
      department = existing.department;
    }
    const payload = Buffer.from(JSON.stringify({ uid: user.uid, name, department, reconnectId: input.reconnectId ?? null, exp: Date.now() + 10 * 60_000, n: randomToken(8) })).toString('base64url');
    const sig = crypto.createHmac('sha256', this.stateKey).update(payload).digest('base64url');
    const q = new URLSearchParams({
      client_id: this.o.google!.clientId,
      redirect_uri: this.googleRedirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: `${payload}.${sig}`,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  /** OAuth callback: verifies the signed state, exchanges the code, stores the refresh token encrypted. */
  async finishGoogle(code: string, state: string): Promise<Credential> {
    const [payload, sig] = state.split('.');
    const expected = crypto.createHmac('sha256', this.stateKey).update(payload ?? '').digest('base64url');
    if (!payload || !sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw badRequest('Invalid sign-in state. Please try connecting again.');
    }
    const st = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (Date.now() > st.exp) throw badRequest('The sign-in took too long. Please try connecting again.');
    const user = await this.o.repos.users.get(st.uid);
    if (!user || user.status !== 'active' || !hasPermission(user, 'credential.manage')) throw forbidden();

    const res = await this.fetchJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.o.google!.clientId,
        client_secret: this.o.google!.clientSecret,
        redirect_uri: this.googleRedirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (res.status !== 200 || !res.json.refresh_token) {
      throw badRequest(`Google did not return a refresh token (${res.json.error_description ?? res.json.error ?? res.status})`);
    }
    // The id_token came straight from Google over TLS, so reading its email claim is safe here.
    const claims = res.json.id_token ? JSON.parse(Buffer.from(String(res.json.id_token).split('.')[1], 'base64url').toString('utf8')) : {};
    const scopes = String(res.json.scope ?? '').split(' ').filter(Boolean);

    if (st.reconnectId) {
      const existing = await this.o.repos.credentials.get(st.reconnectId);
      if (!existing || existing.provider !== 'google_oauth') throw badRequest('That Google connection no longer exists');
      const wanted = existing.details.accountEmail;
      if (wanted && claims.email && String(claims.email).toLowerCase() !== String(wanted).toLowerCase()) {
        throw badRequest(`You signed in as ${claims.email}, but this connection is for ${wanted}. Click Reconnect again and choose ${wanted} on Google's page.`);
      }
      await this.o.repos.credentialSecrets.set(existing.credentialId, this.o.box.encrypt(JSON.stringify({ refreshToken: res.json.refresh_token })));
      await this.o.repos.credentials.update(existing.credentialId, {
        status: 'connected',
        details: { ...existing.details, accountEmail: claims.email ?? wanted ?? null, scopes } as Credential['details'],
        lastTestedAt: nowIso(),
        lastTestResult: 'Reconnected',
        updatedAt: nowIso(),
      });
      this.tokens.set(existing.credentialId, { accessToken: res.json.access_token, expiresAt: Date.now() + (res.json.expires_in ?? 3600) * 1000, email: claims.email ?? wanted ?? null });
      return (await this.o.repos.credentials.get(existing.credentialId))!;
    }

    const c = await this.save(
      user,
      {
        name: st.name,
        provider: 'google_oauth',
        department: st.department ?? null,
        details: { accountEmail: claims.email ?? null, scopes } as Credential['details'],
      },
      { refreshToken: res.json.refresh_token },
    );
    this.tokens.set(c.credentialId, { accessToken: res.json.access_token, expiresAt: Date.now() + (res.json.expires_in ?? 3600) * 1000, email: claims.email ?? null });
    return c;
  }

  /* ------------------------------------------------------------ runtime access */

  private async readSecret(id: string): Promise<Record<string, any>> {
    const enc = await this.o.repos.credentialSecrets.get(id);
    if (!enc) throw new NodeError('Connection secret is missing — reconnect it on the Credentials page', { code: 'CREDENTIAL_MISSING' });
    return JSON.parse(this.o.box.decrypt(enc));
  }

  private async loadForRun(id: string, provider: Credential['provider'], department: string | null) {
    const c = await this.o.repos.credentials.get(id);
    if (!c) throw new NodeError('The selected connection no longer exists', { code: 'CREDENTIAL_MISSING' });
    if (c.provider !== provider) throw new NodeError('The selected connection is the wrong type for this node', { code: 'CREDENTIAL_TYPE' });
    if (!this.usableBy(c, department)) throw new NodeError(`Connection “${c.name}” belongs to another department`, { code: 'CREDENTIAL_FORBIDDEN' });
    if (c.status === 'error') throw new NodeError(`Connection “${c.name}” needs attention: ${c.lastTestResult ?? 'reconnect it'}`, { code: 'CREDENTIAL_ERROR' });
    return c;
  }

  async googleToken(id: string, department: string | null) {
    const c = await this.loadForRun(id, 'google_oauth', department);
    const cached = this.tokens.get(id);
    const scopes = c.details.scopes ?? [];
    if (cached && cached.expiresAt - 60_000 > Date.now()) return { accessToken: cached.accessToken, email: cached.email ?? c.details.accountEmail ?? null, scopes };
    if (!this.googleConfigured) throw new NodeError('Google sign-in is not configured on the server', { code: 'SERVICE_UNAVAILABLE' });
    const secret = await this.readSecret(id);
    const res = await this.fetchJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.o.google!.clientId, client_secret: this.o.google!.clientSecret, refresh_token: secret.refreshToken, grant_type: 'refresh_token' }).toString(),
    });
    if (res.status !== 200) {
      if (res.json.error === 'invalid_grant') {
        await this.o.repos.credentials.update(id, { status: 'error', lastTestResult: 'Google access was revoked or expired — reconnect the account', lastTestedAt: nowIso() });
      }
      throw new NodeError(`Google token refresh failed: ${res.json.error_description ?? res.json.error ?? res.status}`, { code: 'GOOGLE_AUTH', retryable: res.status >= 500 });
    }
    const entry = { accessToken: res.json.access_token, expiresAt: Date.now() + (res.json.expires_in ?? 3600) * 1000, email: c.details.accountEmail ?? null };
    this.tokens.set(id, entry);
    return { accessToken: entry.accessToken, email: entry.email, scopes };
  }

  /**
   * Sends one plain-text email from a Google connection. Used for system
   * alerts (not by workflows, which use the Gmail Send node).
   */
  async sendSystemEmail(credentialId: string, to: string[], subject: string, body: string) {
    const own = await this.o.repos.credentials.get(credentialId);
    const { accessToken, email, scopes } = await this.googleToken(credentialId, own?.department ?? null);
    if (scopes.length && !scopes.some((s) => s.includes('gmail.send') || s === 'https://mail.google.com/')) {
      throw badRequest('This Google connection is not allowed to send email. Reconnect it with Gmail ticked.');
    }
    const mime = buildMime({ from: email ?? 'me', to: to.join(', '), subject, body, html: false });
    const res = await this.fetchJson('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(mime, 'utf8').toString('base64url') }),
    });
    if (res.status >= 300) throw new Error(`Gmail: ${res.json?.error?.message ?? `HTTP ${res.status}`}`);
    return { messageId: res.json?.id as string | undefined };
  }

  private async firestoreFor(c: Credential): Promise<Firestore> {
    const cached = this.firestores.get(c.credentialId);
    if (cached) return cached;
    const { serviceAccount } = await this.readSecret(c.credentialId);
    const appName = `cred_${c.credentialId}_${c.updatedAt}`;
    const db = this.o.connectFirestore
      ? this.o.connectFirestore(serviceAccount, appName)
      : (() => {
          let app;
          try {
            app = getApp(appName);
          } catch {
            app = initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id }, appName);
          }
          const fs = getFirestore(app);
          fs.settings({ ignoreUndefinedProperties: true });
          return fs;
        })();
    this.firestores.set(c.credentialId, db);
    return db;
  }

  /** Restricted Firestore handle for a Firebase node. */
  async firestoreAccess(id: string, department: string | null): Promise<FirestoreAccess> {
    const c = await this.loadForRun(id, 'firebase_service_account', department);
    const db = await this.firestoreFor(c);
    const own = c.details.projectId === this.o.ownProjectId;
    const allowed = c.details.allowedCollections ?? [];
    const readOnly = !!c.details.readOnly;

    const checkCollection = (path: string) => {
      const segs = path.split('/').filter(Boolean);
      if (!segs.length || segs.length % 2 !== 1 || segs.some((s) => s === '.' || s === '..')) {
        throw new NodeError(`“${path}” is not a collection path`, { code: 'BAD_PATH' });
      }
      if (own && PLATFORM_COLLECTIONS.has(segs[0])) throw new NodeError(`“${segs[0]}” belongs to the automation platform and cannot be used`, { code: 'COLLECTION_FORBIDDEN' });
      if (!collectionAllowed(segs.join('/'), allowed)) {
        throw new NodeError(`Collection “${segs.join('/')}” is not allowed by connection “${c.name}”. Allowed: ${allowed.join(', ') || 'none'}`, { code: 'COLLECTION_FORBIDDEN' });
      }
      return segs.join('/');
    };
    const checkDoc = (path: string) => {
      const segs = path.split('/').filter(Boolean);
      if (segs.length < 2 || segs.length % 2 !== 0) throw new NodeError(`“${path}” is not a document path`, { code: 'BAD_PATH' });
      checkCollection(segs.slice(0, -1).join('/'));
      return segs.join('/');
    };
    const write = () => {
      if (readOnly) throw new NodeError(`Connection “${c.name}” is read-only`, { code: 'READ_ONLY' });
    };
    const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err: any) {
        if (err instanceof NodeError) throw err;
        const code = err?.code;
        // gRPC codes: 5 NOT_FOUND, 6 ALREADY_EXISTS, 7 PERMISSION_DENIED, 9 FAILED_PRECONDITION (index), 14 UNAVAILABLE
        const retryable = code === 14 || code === 4 || code === 8;
        const friendly: Record<number, string> = {
          5: 'The document does not exist',
          6: 'A document with this ID already exists (Firebase Create never overwrites — use Firebase Update)',
          7: 'The service account is not allowed to do this in that project (check its IAM role)',
        };
        const detail = friendly[code] ?? err?.details ?? err?.message ?? String(err);
        throw new NodeError(`Firestore: ${detail}`, { code: `FIRESTORE_${code ?? 'ERROR'}`, retryable });
      }
    };
    const toDoc = (snap: FirebaseFirestore.DocumentSnapshot): FirestoreDoc => ({ id: snap.id, path: snap.ref.path, data: toPlain(snap.data() ?? {}) as Record<string, unknown> });

    return {
      get: (path) => wrap(async () => {
        const snap = await db.doc(checkDoc(path)).get();
        return snap.exists ? toDoc(snap) : null;
      }),
      query: (collection, opts) => wrap(async () => {
        let q: FirebaseFirestore.Query = db.collection(checkCollection(collection));
        for (const w of opts.where) q = q.where(w.field, w.op, w.value);
        if (opts.orderBy) q = q.orderBy(opts.orderBy.field, opts.orderBy.direction);
        const snap = await q.limit(Math.min(500, Math.max(1, opts.limit))).get();
        return snap.docs.map(toDoc);
      }),
      create: (collection, data, docId) => wrap(async () => {
        write();
        const col = db.collection(checkCollection(collection));
        const ref = docId ? col.doc(docId) : col.doc();
        await ref.create(data);
        return { id: ref.id, path: ref.path };
      }),
      update: (path, data, merge) => wrap(async () => {
        write();
        const ref = db.doc(checkDoc(path));
        if (merge) await ref.set(data, { merge: true });
        else await ref.update(data);
      }),
      delete: (path) => wrap(async () => {
        write();
        await db.doc(checkDoc(path)).delete();
      }),
    };
  }

  /* ------------------------------------------------------------ test */

  async test(id: string): Promise<{ ok: boolean; message: string }> {
    const c = await this.o.repos.credentials.get(id);
    if (!c) throw notFound('Connection not found');
    let result: { ok: boolean; message: string };
    try {
      if (c.provider === 'firebase_service_account') {
        const db = await this.firestoreFor(c);
        const first = (c.details.allowedCollections ?? []).find((p) => !p.includes('*'));
        if (first) await db.collection(first).limit(1).get();
        else await db.listCollections();
        result = { ok: true, message: `Connected to ${c.details.projectId}` };
      } else if (c.provider === 'google_oauth') {
        this.tokens.delete(id);
        const { accessToken } = await this.googleToken(id, c.department);
        const res = await this.fetchJson('https://gmail.googleapis.com/gmail/v1/users/me/profile', { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } });
        result = res.status === 200 ? { ok: true, message: `Connected as ${res.json.emailAddress}` } : { ok: false, message: res.json?.error?.message ?? `HTTP ${res.status}` };
      } else if (c.provider === 'website_login') {
        result = { ok: true, message: `Saved for ${c.details.loginUrl}. The assistant tests it when it signs in.` };
      } else if (c.provider === 'ai_provider') {
        const { apiKey } = await this.readSecret(id);
        result = await this.tryAi(c.details.aiService ?? 'openai', c.details.model ?? AI_SERVICE_INFO[c.details.aiService ?? 'openai'].defaultModel, apiKey);
      } else {
        result = { ok: true, message: 'Event source key is stored. Send a test event to check the app side.' };
      }
    } catch (err: any) {
      result = { ok: false, message: err?.details ?? err?.message ?? String(err) };
    }
    await this.o.repos.credentials.update(id, { status: result.ok ? 'connected' : 'error', lastTestedAt: nowIso(), lastTestResult: result.message });
    return result;
  }

  async remove(id: string) {
    await this.o.repos.credentialSecrets.delete(id);
    await this.o.repos.credentials.delete(id);
    this.firestores.delete(id);
    this.tokens.delete(id);
  }

  async updateFirebaseAccess(id: string, allowedCollections: string[], readOnly: boolean) {
    const c = await this.o.repos.credentials.get(id);
    if (!c || c.provider !== 'firebase_service_account') throw notFound('Connection not found');
    const allowed = normaliseCollections(allowedCollections, c.details.projectId === this.o.ownProjectId);
    await this.o.repos.credentials.update(id, { details: { ...c.details, allowedCollections: allowed, readOnly }, updatedAt: nowIso() });
  }
}

function normaliseCollections(list: string[], ownProject: boolean): string[] {
  const out = [...new Set(list.map((s) => s.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean))];
  for (const p of out) {
    const segs = p.split('/');
    if (segs.length % 2 !== 1) throw badRequest(`“${p}” is a document path; list collections (e.g. bookings or tenants/*/payments)`);
    if (segs.some((s) => !/^(\*|[A-Za-z0-9_.-]+)$/.test(s))) throw badRequest(`“${p}” contains invalid characters`);
    if (segs[0] === '*') throw badRequest('The first part of a collection path cannot be *');
    if (ownProject && PLATFORM_COLLECTIONS.has(segs[0])) throw badRequest(`“${segs[0]}” belongs to the automation platform`);
  }
  if (!out.length) throw badRequest('List at least one collection the nodes may use');
  return out;
}

/** Converts Firestore values to plain JSON (Timestamps → ISO strings, refs → paths). */
export function toPlain(v: unknown): unknown {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (v instanceof DocumentReference) return v.path;
  if (v instanceof GeoPoint) return { latitude: v.latitude, longitude: v.longitude };
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  if (Array.isArray(v)) return v.map(toPlain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPlain(x)]));
  return v;
}

/** Checks a website login's addresses: https only, and the login page must be on an allowed domain. */
function websiteDetails(loginUrl: string, domains: string[], username: string, selectors?: { username?: string; password?: string; submit?: string }) {
  let url: URL;
  try {
    url = new URL(loginUrl.trim());
  } catch {
    throw badRequest('The login page address is not a valid web address (it should start with https://)');
  }
  if (url.protocol !== 'https:') throw badRequest('The login page must use https://');
  const allowedDomains = [...new Set([url.hostname.toLowerCase(), ...domains.map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean)])].slice(0, 10);
  if (allowedDomains.some((d) => !/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d))) throw badRequest('Allowed websites must look like mytnb.com.my');
  const clean = (v?: string) => (v && v.trim() ? v.trim().slice(0, 200) : undefined);
  const sel = selectors ? { username: clean(selectors.username), password: clean(selectors.password), submit: clean(selectors.submit) } : undefined;
  return { loginUrl: url.toString(), allowedDomains, usernameHint: maskUsername(username), ...(sel && (sel.username || sel.password || sel.submit) ? { selectors: sel } : {}) };
}
