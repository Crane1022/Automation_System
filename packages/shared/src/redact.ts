/**
 * Helpers used before anything is written to execution logs.
 * - redactSecrets: masks values whose keys look secret.
 * - limitSize: replaces oversized payloads with a preview.
 */

const SECRET_KEY = /(pass(word)?|secret|token|authorization|api[-_]?key|cookie|private[-_]?key|client[-_]?secret|signature)/i;

export const REDACTED = '[REDACTED]';

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[MAX_DEPTH]';
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && v !== null && v !== undefined && v !== '' ? REDACTED : redactSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function limitSize(value: unknown, maxBytes: number): unknown {
  let text: string;
  try {
    text = JSON.stringify(value) ?? 'null';
  } catch {
    return { truncated: true, reason: 'not serializable' };
  }
  const size = new TextEncoder().encode(text).length;
  if (size <= maxBytes) return value;
  return { truncated: true, originalBytes: size, preview: text.slice(0, Math.min(2000, maxBytes)) };
}
