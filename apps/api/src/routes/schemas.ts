import { z } from 'zod';
import { EXECUTION_STATUSES, ROLES } from '@widebed/shared';

/** Request body schemas. Every route validates its input with one of these. */

const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/, 'Invalid id');

export const definitionSchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z
    .array(
      z.object({
        id,
        type: z.string().min(1).max(100),
        name: z.string().trim().min(1).max(100),
        position: z.object({ x: z.number(), y: z.number() }),
        config: z.record(z.unknown()).default({}),
        credentialId: z.string().max(100).nullable().optional(),
        disabled: z.boolean().optional(),
        retry: z.object({ maxAttempts: z.number().int().min(1).max(10), backoffMs: z.number().int().min(0).max(600000) }).optional(),
        notes: z.string().max(2000).optional(),
      }),
    )
    .max(200),
  connections: z
    .array(z.object({ id, source: id, sourceHandle: z.string().max(50), target: id, targetHandle: z.string().max(50) }))
    .max(1000),
  settings: z
    .object({
      timeoutMs: z.number().int().min(1000).max(24 * 3600_000).optional(),
      defaultRetry: z.object({ maxAttempts: z.number().int().min(1).max(10), backoffMs: z.number().int().min(0).max(600000) }).optional(),
    })
    .default({}),
});

const tags = z.array(z.string().trim().min(1).max(40)).max(20);

export const createWorkflowSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  folderId: id.nullable().default(null),
  department: z.string().trim().max(80).nullable().default(null),
  tags: tags.default([]),
});

export const updateWorkflowSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  folderId: id.nullable().optional(),
  department: z.string().trim().max(80).nullable().optional(),
  tags: tags.optional(),
  sharedWith: z.array(z.string().max(128)).max(200).optional(),
});

export const runSchema = z.object({
  mode: z.enum(['draft', 'published']).default('draft'),
  triggerNodeId: id.optional(),
  /** Payload handed to the Manual Trigger. Object → 1 item, array → n items. */
  payload: z.unknown().optional(),
});

export const folderSchema = z.object({
  name: z.string().trim().min(1).max(80),
  department: z.string().trim().max(80).nullable().default(null),
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(ROLES).optional(),
  department: z.string().trim().max(80).nullable().optional(),
  status: z.enum(['active', 'pending', 'disabled']).optional(),
});

export const inviteUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().min(1).max(120),
  role: z.enum(ROLES),
  department: z.string().trim().max(80).nullable().default(null),
});

export const executionQuerySchema = z.object({
  workflowId: id.optional(),
  status: z.enum(EXECUTION_STATUSES).optional(),
  triggerType: z.enum(['manual', 'webhook', 'schedule', 'http_event', 'retry']).optional(),
  department: z.string().max(80).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const statsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const systemSettingsSchema = z.object({
  alerts: z.object({
    enabled: z.boolean(),
    emails: z.array(z.string().trim().email('One of the alert emails is not a valid address')).max(20),
    credentialId: z.string().max(100).nullable(),
    cooldownMinutes: z.number().int().min(5).max(24 * 60),
  }),
  ai: z
    .object({
      lowRiskPolicy: z.enum(['auto', 'auto_in_chat', 'ask']),
      approvalHours: z.number().int().min(1).max(24 * 7),
    })
    .optional(),
  code: z.object({ whoCanWrite: z.enum(['it_admin', 'editors']) }).optional(),
});

export const dailyQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(60).default(14),
  tz: z.string().max(64).optional(),
});

const shortList = (max: number, len: number) => z.array(z.string().trim().min(1).max(len)).max(max);
export const agentInputSchema = z.object({
  name: z.string().trim().min(1, 'Give the AI employee a name').max(80),
  avatar: z.string().trim().min(1).max(16),
  color: z.enum(['brand', 'blue', 'amber', 'rose', 'violet', 'slate']),
  title: z.string().trim().max(80),
  department: z.string().trim().max(60).nullable(),
  description: z.string().trim().max(500),
  personality: z.string().trim().max(500),
  communicationStyle: z.string().trim().max(500),
  responsibilities: shortList(20, 200),
  expertise: shortList(20, 60),
  instructions: z.string().max(8000),
  aiCredentialId: z.string().max(100).nullable(),
  model: z.string().trim().max(120).nullable(),
  temperature: z.number().min(0).max(1).nullable(),
  maxOutputTokens: z.number().int().min(500).max(32000),
  tools: z.object({
    memory: z.boolean(),
    workflows: z.boolean(),
    pms: z.boolean(),
    browser: z.boolean(),
    websites: z.union([z.literal('all'), z.array(z.string().max(100)).max(50)]),
    knowledge: z.boolean().default(true),
  }),
  memoryEnabled: z.boolean(),
  canDelegate: z.boolean().default(false),
  maxSteps: z.number().int().min(1).max(30),
  visibility: z.enum(['private', 'department', 'company']),
  allowedUserIds: z.array(z.string().max(128)).max(200),
  managerIds: z.array(z.string().max(128)).max(50).default([]),
  approverIds: z.array(z.string().max(128)).max(50).default([]),
  allowedRoles: z.array(z.enum(['super_admin', 'admin', 'it_admin', 'department_manager', 'employee'])).max(5),
  status: z.enum(['active', 'disabled', 'archived']),
  templateId: z.string().max(60).nullable(),
});
