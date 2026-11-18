import { redactSecrets } from '@widebed/shared';
import { newId, nowIso } from '../lib/ids.js';
import type { AuditRepo } from '../repositories/types.js';

export type AuditFn = (entry: {
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}) => Promise<void>;

/** Writes an audit record. Failures are logged but never break the request. */
export function createAuditLogger(repo: AuditRepo): AuditFn {
  return async (e) => {
    try {
      await repo.add({
        logId: newId('log'),
        actorId: e.actorId,
        action: e.action,
        resourceType: e.resourceType,
        resourceId: e.resourceId ?? null,
        timestamp: nowIso(),
        metadata: redactSecrets(e.metadata ?? {}) as Record<string, unknown>,
      });
    } catch (err) {
      console.error('[audit] failed to write audit log', err);
    }
  };
}
