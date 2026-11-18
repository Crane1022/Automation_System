/**
 * Approval Center — AI staff propose actions, people decide.
 *
 *   Firestore (server only): aiApprovals/{approvalId}
 *
 * Every approval is tied to ONE exact action: the tool and its parameters (hashed).
 * It can be used once, it expires, it records who decided, and permissions are
 * checked again before the action really runs.
 */

/** 1 read only · 2 low risk · 3 sensitive · 4 critical. */
export type RiskLevel = 1 | 2 | 3 | 4;

export const RISK_LEVELS: Record<RiskLevel, { label: string; short: string; explain: string }> = {
  1: { label: 'Level 1 · Read only', short: 'Read only', explain: 'Looks things up. Never needs approval.' },
  2: { label: 'Level 2 · Low risk', short: 'Low risk', explain: 'Small, reversible steps (e.g. typing into a website form). Automatic only if an Admin allows it.' },
  3: { label: 'Level 3 · Sensitive', short: 'Sensitive', explain: 'Sends, submits, runs or changes something. Always needs approval.' },
  4: { label: 'Level 4 · Critical', short: 'Critical', explain: 'Payments, deleting, cancelling. Needs an Admin or a named approver, who must type APPROVE.' },
};

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'replaced';

export interface AgentApproval {
  approvalId: string;
  source: 'chat' | 'task';
  chatId: string | null;
  taskId: string | null;
  agentId: string;
  agentName: string;
  agentAvatar: string;
  agentColor: string;
  department: string | null;
  /** The person the action runs for (chat owner, or the task's runAs). */
  requestedFor: string;
  /** Chat or task title, for context. */
  title: string;
  tool: string;
  /** Plain words, e.g. “Run workflow: Rent reminder”. */
  toolLabel: string;
  /** The exact parameters that will be used. */
  input: unknown;
  /** sha256 of tool + parameters: what was approved can't change afterwards. */
  inputHash: string;
  /** What will happen, in plain words. */
  details: string;
  /** e.g. “Workflows”, “Website: myTNB”. */
  target: string;
  level: RiskLevel;
  /** What the AI employee said when asking. */
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
  /** Set when this request is an edited version of another one. */
  editedFrom: string | null;
  editedBy: string | null;
  /** When the approved action actually ran (single use). */
  usedAt: string | null;
}

export type AgentApprovalView = AgentApproval & {
  requestedForName: string;
  decidedByName: string | null;
  canDecide: boolean;
  /** Why this person can't decide, if they can't. */
  whyNot: string | null;
};

/** How level 2 (low risk) actions are handled — an Admin policy. */
export type LowRiskPolicy = 'auto' | 'auto_in_chat' | 'ask';

export const LOW_RISK_POLICY_LABELS: Record<LowRiskPolicy, string> = {
  auto_in_chat: 'Automatic in chats (a person is watching); ask in background tasks',
  ask: 'Always ask',
  auto: 'Always automatic',
};

/** Words a person types to approve a critical action. */
export const CRITICAL_CONFIRM_WORD = 'APPROVE';

/** Same parameters → same text, whatever the key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
