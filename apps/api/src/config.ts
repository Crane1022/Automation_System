import { z } from 'zod';

/**
 * All configuration comes from environment variables (see .env.example).
 * The server refuses to start if something required is missing.
 */
const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');
const list = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  /** Public base URL used to build webhook URLs, e.g. https://automation.widebed.com */
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),
  CORS_ORIGINS: list,
  TRUST_PROXY: bool,

  FIREBASE_PROJECT_ID: z.string().min(1, 'FIREBASE_PROJECT_ID is required'),
  /** Path to a service-account JSON mounted as a secret (never committed). */
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  /** Alternative: base64 of the service-account JSON. */
  FIREBASE_SERVICE_ACCOUNT_BASE64: z.string().optional(),

  /** 32 random bytes, base64. Used for AES-256-GCM secret encryption. */
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes, base64-encoded'),

  /** Emails that become super_admin on first login (bootstrap). */
  SUPER_ADMIN_EMAILS: list,

  EXECUTION_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  /** AI Staff background tasks run at once per worker, and the longest one task may take. */
  AI_TASK_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),
  AI_TASK_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(600_000),
  EXECUTION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(5 * 60 * 1000),
  EXECUTION_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  MAX_QUEUE_LENGTH: z.coerce.number().int().min(1).default(1000),

  HTTP_ALLOW_PRIVATE_NETWORKS: bool,
  HTTP_ALLOWED_PRIVATE_HOSTS: list,
  HTTP_MAX_RESPONSE_BYTES: z.coerce.number().int().default(5 * 1024 * 1024),

  /** Redis for the durable queue, schedules and live events. Empty = single-process mode (dev/tests). */
  REDIS_URL: z.string().optional(),
  /** Whether this process runs jobs. Production: false on the API, true on worker containers. */
  PROCESS_JOBS: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
  /** Longest pause a Wait node may take. */
  WAIT_MAX_MS: z.coerce.number().int().min(1000).default(60 * 60 * 1000),
  CODE_MAX_MEMORY_MB: z.coerce.number().int().min(16).max(1024).default(128),
  /** Time zone used by `new Date()` inside Code nodes. */
  CODE_TIMEZONE: z.string().default('Asia/Kuala_Lumpur'),
  /** Assistant: where downloaded files (e.g. bills) are kept for 7 days. Default: the system temp folder. */
  ASSISTANT_FILES_DIR: z.string().optional(),
  /** Assistant: allow the web browser (needs Playwright + Chromium installed). */
  ASSISTANT_BROWSER: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

  /** Google OAuth client (Google Cloud console → APIs & Services → Credentials) for Gmail. */
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),

  WEBHOOK_MAX_BODY_BYTES: z.coerce.number().int().default(1024 * 1024),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(300),
  WEBHOOK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(120),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.HTTP_ALLOW_PRIVATE_NETWORKS) {
    console.warn('[config] HTTP_ALLOW_PRIVATE_NETWORKS is enabled in production — SSRF protection is weakened.');
  }
  return parsed.data;
}
