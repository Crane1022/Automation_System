/**
 * Credentials: connections to outside systems.
 *
 * The metadata below (name, provider, status, non-secret details) lives in
 * `credentials/{id}` and is safe to show in the UI. The secret part (service
 * account key, OAuth refresh token, event key hash) is AES-256-GCM encrypted in
 * `credentialSecrets/{id}` — `encryptedSecretReference` points to it — and is
 * only ever decrypted inside the API / worker while a node runs.
 */

export const CREDENTIAL_PROVIDERS = ['firebase_service_account', 'google_oauth', 'event_source', 'ai_provider', 'website_login'] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

export interface CredentialDetails {
  /** firebase_service_account */
  projectId?: string;
  clientEmail?: string;
  /** Collections the nodes may touch, e.g. ["bookings", "tenants/*\/payments"]. */
  allowedCollections?: string[];
  readOnly?: boolean;
  /** google_oauth */
  accountEmail?: string;
  scopes?: string[];
  /** event_source / ai_provider: first characters of the key, to recognise it. */
  keyPrefix?: string;
  /** ai_provider */
  aiService?: AiService;
  model?: string;
  /** Last 4 characters of the API key, to recognise it. */
  keyEnding?: string;
  /** website_login: where the assistant's browser signs in, and which sites it may open. */
  loginUrl?: string;
  allowedDomains?: string[];
  /** Username shown partly, e.g. "ne•••@widebed.com". The real one is in the encrypted secret. */
  usernameHint?: string;
  /** Optional CSS selectors when the login page is unusual (set by IT). */
  selectors?: { username?: string; password?: string; submit?: string };
}

export interface Credential {
  credentialId: string;
  name: string;
  provider: CredentialProvider;
  ownerId: string;
  /** null = usable by every department. */
  department: string | null;
  status: 'connected' | 'error' | 'pending';
  details: CredentialDetails;
  encryptedSecretReference: string;
  lastTestedAt: string | null;
  lastTestResult: string | null;
  createdAt: string;
  updatedAt: string;
}

export const PROVIDER_LABELS: Record<CredentialProvider, string> = {
  firebase_service_account: 'Firebase / Firestore project',
  google_oauth: 'Google account (Gmail)',
  event_source: 'Event source (PMS, TMS…)',
  ai_provider: 'AI service (OpenAI, Claude, Gemini)',
  website_login: 'Website login (for the assistant’s browser)',
};

/** "neokahoong@widebed.com" → "ne•••@widebed.com", "220012345678" → "22•••78". */
export function maskUsername(u: string): string {
  const s = u.trim();
  const at = s.indexOf('@');
  if (at > 0) return `${s.slice(0, Math.min(2, at))}•••${s.slice(at)}`;
  return s.length <= 4 ? '•••' : `${s.slice(0, 2)}•••${s.slice(-2)}`;
}

/** Host names a website login may open: the login page's host plus the listed domains (and their sub-domains). */
export function hostAllowed(host: string, domains: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return domains.some((d) => {
    const x = d.toLowerCase().trim().replace(/^\*\./, '').replace(/\.$/, '');
    return !!x && (h === x || h.endsWith(`.${x}`));
  });
}

/* ------------------------------------------------------------------ AI */

export const AI_SERVICES = ['openai', 'anthropic', 'gemini'] as const;
export type AiService = (typeof AI_SERVICES)[number];

/** What the Credentials page shows for each AI service. Model names change often: they can be edited. */
export const AI_SERVICE_INFO: Record<AiService, { label: string; defaultModel: string; models: string[]; keyUrl: string; keyHint: string }> = {
  openai: {
    label: 'OpenAI (ChatGPT)',
    defaultModel: 'gpt-5.4-mini',
    models: ['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.5'],
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'starts with sk-',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-haiku-5-5',
    models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'starts with sk-ant-',
  },
  gemini: {
    label: 'Google Gemini',
    defaultModel: 'gemini-flash-latest',
    models: ['gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'],
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyHint: 'from Google AI Studio',
  },
};

/** Simple glob for collection paths: "*" matches exactly one path segment. */
export function collectionAllowed(path: string, patterns: string[]): boolean {
  const segs = path.split('/').filter(Boolean);
  return patterns.some((p) => {
    const ps = p.split('/').filter(Boolean);
    return ps.length === segs.length && ps.every((x, i) => x === '*' || x === segs[i]);
  });
}
