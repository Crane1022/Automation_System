import type { Node, Edge } from '@vue-flow/core';
import type { ExecutionStep, RetryPolicy } from '@widebed/shared';

/** Data stored on each Vue Flow node. Mirrors WorkflowNode plus UI-only state. */
export interface WbNodeData {
  nodeType: string;
  name: string;
  config: Record<string, unknown>;
  disabled?: boolean;
  retry?: RetryPolicy;
  credentialId?: string | null;
  notes?: string;
  /** UI only: last run result for this node. */
  exec?: { status: ExecutionStep['status']; items?: number; error?: string | null; attempt?: number };
  /** UI only: validation messages from the backend. */
  issues?: string[];
}

export type WbNode = Node<WbNodeData>;
export type WbEdge = Edge;
