import type { NodeCategory, NodeDescriptor, ValidationIssue, WorkflowNode } from '@widebed/shared';
import type { NodeImplementation } from './types.js';
import { manualTrigger } from './nodes/manual-trigger.js';
import { webhookTrigger } from './nodes/webhook-trigger.js';
import { ifCondition } from './nodes/if-condition.js';
import { httpRequest } from './nodes/http-request.js';
import { combineNode, filterNode, limitNode, loopNode, mergeNode, switchNode, waitNode } from './nodes/logic.js';
import { eventTrigger, scheduleTrigger } from './nodes/triggers.js';
import { codeNode } from './nodes/code.js';
import { firebaseCreate, firebaseDelete, firebaseRead, firebaseUpdate } from './nodes/firebase.js';
import { gmailRead, gmailSend } from './nodes/gmail.js';
import { sheetsCreateRow, sheetsRead, sheetsUpdateRow } from './nodes/sheets.js';
import { aiAgent, aiChat, aiClassify, aiExtract } from './nodes/ai.js';
import { aiChatbot } from './nodes/chatbot.js';
import { unsupportedNode } from './nodes/unsupported.js';

/**
 * The node registry. To add a node type:
 *   1. create a file in ./nodes using defineNode(...)
 *   2. register it below (or call registry.register at startup for custom nodes)
 */
export class NodeRegistry {
  private nodes = new Map<string, NodeImplementation>();

  register(impl: NodeImplementation): this {
    if (this.nodes.has(impl.descriptor.type)) {
      throw new Error(`Node type already registered: ${impl.descriptor.type}`);
    }
    this.nodes.set(impl.descriptor.type, impl);
    return this;
  }

  get(type: string): NodeImplementation | undefined {
    return this.nodes.get(type);
  }

  has(type: string): boolean {
    return this.nodes.has(type);
  }

  descriptors(): NodeDescriptor[] {
    return [...this.nodes.values()].map((n) => n.descriptor);
  }

  /** Validates one node's config against its schema. */
  validateNodeConfig(node: WorkflowNode): ValidationIssue[] {
    const impl = this.get(node.type);
    if (!impl) return [{ nodeId: node.id, message: `Unknown node type "${node.type}"`, severity: 'error' }];
    const result = impl.configSchema.safeParse(node.config ?? {});
    if (result.success) return [];
    return result.error.issues.map((i) => ({
      nodeId: node.id,
      field: i.path.join('.') || undefined,
      message: `${node.name}: ${i.path.length ? i.path.join('.') + ' — ' : ''}${i.message}`,
      severity: 'error' as const,
    }));
  }
}

export function createDefaultRegistry(): NodeRegistry {
  const all = [
    // triggers
    manualTrigger, webhookTrigger, scheduleTrigger, eventTrigger,
    // logic
    ifCondition, switchNode, filterNode, mergeNode, loopNode, waitNode, combineNode, limitNode,
    // data
    httpRequest, codeNode, firebaseRead, firebaseCreate, firebaseUpdate, firebaseDelete,
    // communication
    gmailSend, gmailRead,
    sheetsRead, sheetsCreateRow, sheetsUpdateRow,
    aiChat, aiChatbot, aiClassify, aiExtract, aiAgent,
    // imports
    unsupportedNode,
  ];
  const registry = new NodeRegistry();
  for (const n of all) registry.register(n as NodeImplementation);
  return registry;
}

/** Node types on the roadmap. Shown in the palette as "coming in Phase N", never as usable nodes. */
export interface PlannedNode {
  type: string;
  displayName: string;
  category: NodeCategory;
  icon: string;
  phase: number;
}

export const PLANNED_NODES: PlannedNode[] = [
];
