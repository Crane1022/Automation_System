import crypto from 'node:crypto';

/** Prefixed, URL-safe random ids, e.g. "wf_3kq9...". */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(10).toString('base64url')}`;
}

/** Deterministic id from parts — used for idempotency keys. */
export function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${crypto.createHash('sha256').update(parts.join('\u0000')).digest('base64url').slice(0, 22)}`;
}

export const nowIso = () => new Date().toISOString();
