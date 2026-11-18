import { hasPermission, type AppUser, type Role } from './permissions.js';

/**
 * Company Knowledge: SOPs, house rules, price lists… that AI Staff can look up.
 * Only the TEXT is kept (split into small pieces); uploaded files are never stored.
 */

/** Who may read a document (people) — the AI staff list is separate. */
export interface KnowledgeAudience {
  /** Everyone in the company. When true, departments/roles are ignored. */
  everyone: boolean;
  departments: string[];
  roles: Role[];
}

export interface KnowledgeDoc {
  docId: string;
  title: string;
  /** Simple folder name, '' = no folder. */
  folder: string;
  source: 'typed' | 'upload';
  /** Original file name for uploads (the file itself is not kept). */
  fileName: string | null;
  fileKind: string | null;
  audience: KnowledgeAudience;
  /** Which AI staff may use it. Empty = all AI staff. */
  agentIds: string[];
  chars: number;
  chunkCount: number;
  /** First few hundred characters, for the list. */
  preview: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

/** One piece of a document's text (~1500 characters). */
export interface KnowledgeChunk {
  docId: string;
  index: number;
  text: string;
  /** Distinct search words in this piece (lower case), used to find it quickly. */
  terms: string[];
}

export interface KnowledgeHit {
  docId: string;
  title: string;
  folder: string;
  index: number;
  /** Which piece of how many. */
  of: number;
  text: string;
  score: number;
}

export const KNOWLEDGE_LIMITS = {
  maxChars: 500_000,
  chunkChars: 1500,
  maxTitle: 140,
  maxFolder: 60,
  /** Text of attachments added to one chat message. */
  maxAttachmentChars: 40_000,
  maxAttachments: 3,
};

const STOP = new Set(
  'a an and are as at be but by for from has have i if in into is it its me my no not of on or our so that the their them then there these they this to was we were what when where which who will with you your yang dan di ke dari ini itu untuk dengan pada adalah atau'.split(' '),
);

/** Lower-case search words: letters/numbers, no common filler words, simple plural folding. */
export function searchTerms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*/gu) ?? []) {
    if (raw.length < 2 || raw.length > 40 || STOP.has(raw)) continue;
    out.push(fold(raw));
  }
  return out;
}

function fold(w: string) {
  if (/^\d/.test(w)) return w;
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** May this person read the document? (Admins with knowledge.manage see everything.) */
export function canReadKnowledge(user: Pick<AppUser, 'role' | 'department'>, doc: Pick<KnowledgeDoc, 'audience'>): boolean {
  if (hasPermission(user, 'knowledge.manage')) return true;
  const a = doc.audience;
  if (a.everyone) return true;
  if (a.roles.includes(user.role)) return true;
  return !!user.department && a.departments.some((d) => d.toLowerCase() === user.department!.toLowerCase());
}

/** May this AI employee use the document? */
export function agentMayUseKnowledge(agentId: string, doc: Pick<KnowledgeDoc, 'agentIds'>): boolean {
  return !doc.agentIds.length || doc.agentIds.includes(agentId);
}

/** A file the person attached to a chat message — only its text goes to the AI. */
export interface ChatAttachment {
  name: string;
  kind: string;
  chars: number;
}
