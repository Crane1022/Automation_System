/**
 * Workflow JSON format (schemaVersion 1).
 *
 * A workflow is a directed acyclic graph of nodes. Each node has a `type`
 * that maps to an entry in the node registry. Connections join an output
 * handle of one node to an input handle of another.
 */

export const WORKFLOW_SCHEMA_VERSION = 1 as const;

export interface Position {
  x: number;
  y: number;
}

export interface RetryPolicy {
  /** Total attempts including the first one. 1 = no retry. */
  maxAttempts: number;
  /** Delay before the first retry; doubles on each further retry. */
  backoffMs: number;
}

export interface WorkflowNode {
  /** Stable id, unique inside the workflow (e.g. "node_ab12cd"). */
  id: string;
  /** Registry type, e.g. "trigger.manual", "logic.if", "data.httpRequest". */
  type: string;
  /** Human label shown on the canvas. Unique inside the workflow. */
  name: string;
  position: Position;
  /** Node-specific settings. Validated against the node's config schema. */
  config: Record<string, unknown>;
  /** Reference to a stored credential (never the secret itself). */
  credentialId?: string | null;
  /** Disabled nodes pass their input through untouched. */
  disabled?: boolean;
  /** Optional per-node retry policy override. */
  retry?: RetryPolicy;
  notes?: string;
}

export interface WorkflowConnection {
  id: string;
  source: string;
  /** Output handle on the source node, e.g. "main", "true", "false". */
  sourceHandle: string;
  target: string;
  /** Input handle on the target node, usually "main". */
  targetHandle: string;
}

export interface WorkflowSettings {
  /** Whole-execution timeout. */
  timeoutMs?: number;
  /** Default retry policy for nodes that allow retries. */
  defaultRetry?: RetryPolicy;
}

export interface WorkflowDefinition {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
  settings?: WorkflowSettings;
}

export type WorkflowStatus = 'active' | 'inactive';

export interface Workflow {
  workflowId: string;
  name: string;
  description: string;
  folderId: string | null;
  ownerId: string;
  department: string | null;
  /** Active workflows accept trigger events (webhooks, schedules). */
  status: WorkflowStatus;
  tags: string[];
  /** Users (uids) a workflow is explicitly shared with. */
  sharedWith: string[];
  draftDefinition: WorkflowDefinition;
  /** Version number of the latest published snapshot, or null. */
  publishedVersion: number | null;
  /** Document id of the latest workflowVersions snapshot, or null. */
  publishedVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  /** Event names the published version listens to (HTTP Event Trigger). Kept for fast lookup. */
  eventTriggers?: string[];
}

/** Immutable snapshot created on publish. Never edited afterwards. */
export interface WorkflowVersion {
  versionId: string;
  workflowId: string;
  versionNumber: number;
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
  settings?: WorkflowSettings;
  publishedBy: string;
  publishedAt: string;
}

export interface WorkflowFolder {
  folderId: string;
  name: string;
  ownerId: string;
  department: string | null;
  createdAt: string;
}

export function emptyDefinition(): WorkflowDefinition {
  return { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes: [], connections: [], settings: {} };
}
