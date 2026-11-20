/**
 * Serializable description of a node type. The backend registry owns the
 * real implementation (validation + execute); the UI receives this
 * descriptor from GET /api/node-types to render the palette and forms.
 */

export type NodeCategory = 'trigger' | 'logic' | 'data' | 'communication' | 'ai';

/** A single unit of data flowing between nodes (like a row). */
export interface Item {
  json: Record<string, unknown>;
}

export interface HandleDescriptor {
  id: string;
  label?: string;
}

export type FieldType =
  | 'string'
  | 'text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'json'
  | 'keyValue'
  | 'conditions'
  | 'cases'
  | 'firestoreFilters'
  | 'code'
  /** Calendar date picker, value "YYYY-MM-DD". */
  | 'date'
  /** Time picker, value "HH:MM" (24-hour). */
  | 'time'
  /** Toggle buttons that allow several choices (uses `options`), value string[]. */
  | 'multiSelect'
  /** Dropdown of `options` that also keeps any other saved value. */
  | 'timezone'
  /** Picks a saved connection of `credentialProvider`; value is its id ('' = none). */
  | 'credential'
  /** A list of small records; each record has the fields in `itemFields` (string / text / number only). */
  | 'list';

export interface FieldDescriptor {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  /** keyValue fields: placeholder text of the left / right box (default “Name” / “Value”). */
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** cases fields: column headings (default “Output name” / “Matches value”) and add-button text. */
  columnLabels?: [string, string];
  addLabel?: string;
  help?: string;
  options?: { label: string; value: string }[];
  /** Whether {{ expressions }} are allowed in this field. */
  expressions?: boolean;
  /** Only show this field when another field has a given value. */
  showIf?: { key: string; equals: unknown[] };
  /** credential fields: which kind of connection can be picked. */
  credentialProvider?: string;
  /** list fields: the fields of one record. */
  itemFields?: FieldDescriptor[];
}

/** JSON-Schema-like description used for documentation and validation hints. */
export interface DataSchema {
  description: string;
  example?: unknown;
}

export interface NodeDescriptor {
  type: string;
  version: number;
  displayName: string;
  description: string;
  category: NodeCategory;
  /** lucide icon name, e.g. "play", "webhook", "globe", "git-branch". */
  icon: string;
  isTrigger: boolean;
  inputs: HandleDescriptor[];
  outputs: HandleDescriptor[];
  fields: FieldDescriptor[];
  inputSchema: DataSchema;
  outputSchema: DataSchema;
  /** Credential provider required before execution, if any. */
  credentialProvider?: string;
  /**
   * Outputs that depend on the config (e.g. one per Switch case).
   * Each entry of config[from] must have an `id` (used as the handle id).
   */
  dynamicOutputs?: { from: string; labelKey: string; fallback?: { id: string; label: string } };
  /** Whether automatic retry is safe (idempotent or read-only operations). */
  retryable: boolean;
  /** Markdown documentation shown in the settings panel. */
  docs: string;
  /** Phase in which the node becomes available. Unavailable nodes are not listed. */
  available: boolean;
}

export interface ValidationIssue {
  nodeId?: string;
  field?: string;
  message: string;
  severity: 'error' | 'warning';
}

/** The output handles a node really has, taking dynamic outputs into account. */
export function resolveOutputs(d: NodeDescriptor, config: Record<string, unknown> | undefined): HandleDescriptor[] {
  if (!d.dynamicOutputs) return d.outputs;
  const raw = config?.[d.dynamicOutputs.from];
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const out: HandleDescriptor[] = list
    .filter((c) => c && typeof c.id === 'string')
    .map((c, i) => ({ id: c.id as string, label: String(c[d.dynamicOutputs!.labelKey] || `Case ${i + 1}`) }));
  if (d.dynamicOutputs.fallback) out.push(d.dynamicOutputs.fallback);
  return out;
}

/** Fields of a node type that hold a connection id in the config (besides the main "Connection"). */
export function credentialFields(d: NodeDescriptor | undefined): { key: string; provider: string }[] {
  return (d?.fields ?? []).filter((f) => f.type === 'credential' && f.credentialProvider).map((f) => ({ key: f.key, provider: f.credentialProvider! }));
}

/** Every connection id a node uses: its main connection plus connection fields in its config. */
export function credentialRefs(node: { credentialId?: string | null; config?: Record<string, unknown> }, d: NodeDescriptor | undefined): string[] {
  const ids = new Set<string>();
  if (node.credentialId) ids.add(node.credentialId);
  for (const f of credentialFields(d)) {
    const v = node.config?.[f.key];
    if (typeof v === 'string' && v.trim()) ids.add(v.trim());
  }
  return [...ids];
}
