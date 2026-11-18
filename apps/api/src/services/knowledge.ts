import {
  KNOWLEDGE_LIMITS,
  ROLES,
  agentMayUseKnowledge,
  canReadKnowledge,
  hasPermission,
  searchTerms,
  type AppUser,
  type KnowledgeAudience,
  type KnowledgeChunk,
  type KnowledgeDoc,
  type KnowledgeHit,
} from '@widebed/shared';
import type { Repositories } from '../repositories/types.js';
import { badRequest, forbidden, notFound } from '../lib/http-error.js';
import { newId, nowIso } from '../lib/ids.js';
import { chunkText } from './text-extract.js';
import type { AgentTool } from '../assistant/agent.js';

export interface KnowledgeInput {
  title: string;
  folder: string;
  text: string;
  audience: KnowledgeAudience;
  agentIds: string[];
  source?: 'typed' | 'upload';
  fileName?: string | null;
  fileKind?: string | null;
}

/**
 * Company Knowledge. Only text is stored, in small pieces, so AI Staff can search it.
 * Who can read a document is checked here, on the server, every time:
 *   people — the document's audience (everyone / departments / roles),
 *   AI staff — the document's AI list (empty = all) AND the person they work for must be allowed.
 */
export class KnowledgeService {
  private cache: { at: number; docs: KnowledgeDoc[] } | null = null;

  constructor(private repos: Repositories) {}

  canManage(user: AppUser) {
    return hasPermission(user, 'knowledge.manage');
  }

  private async allDocs() {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.docs;
    const docs = await this.repos.knowledge.list(2000);
    this.cache = { at: Date.now(), docs };
    return docs;
  }

  async list(user: AppUser) {
    const docs = (await this.allDocs()).filter((d) => canReadKnowledge(user, d));
    return { items: docs, canManage: this.canManage(user) };
  }

  async get(user: AppUser, id: string) {
    const doc = await this.repos.knowledge.get(id);
    if (!doc || !canReadKnowledge(user, doc)) throw notFound('Document not found');
    const chunks = await this.repos.knowledge.chunks(id);
    return { doc, text: chunks.map((c) => c.text).join('\n\n') };
  }

  async create(user: AppUser, input: KnowledgeInput) {
    if (!this.canManage(user)) throw forbidden('Only Admins can add company knowledge');
    const clean = this.check(input);
    const now = nowIso();
    const docId = newId('kdoc');
    const chunks = this.pieces(docId, clean.title, clean.text);
    const doc: KnowledgeDoc = {
      docId,
      title: clean.title,
      folder: clean.folder,
      source: input.source ?? 'typed',
      fileName: input.fileName ?? null,
      fileKind: input.fileKind ?? null,
      audience: clean.audience,
      agentIds: clean.agentIds,
      chars: clean.text.length,
      chunkCount: chunks.length,
      preview: clean.text.slice(0, 300),
      createdBy: user.uid,
      createdByName: user.name,
      createdAt: now,
      updatedAt: now,
      updatedBy: user.uid,
    };
    await this.repos.knowledge.create(doc, chunks);
    this.cache = null;
    return doc;
  }

  async update(user: AppUser, id: string, patch: Partial<KnowledgeInput>) {
    if (!this.canManage(user)) throw forbidden('Only Admins can change company knowledge');
    const doc = await this.repos.knowledge.get(id);
    if (!doc) throw notFound('Document not found');
    const current = patch.text === undefined ? null : patch.text;
    const clean = this.check({
      title: patch.title ?? doc.title,
      folder: patch.folder ?? doc.folder,
      text: current ?? 'x',
      audience: patch.audience ?? doc.audience,
      agentIds: patch.agentIds ?? doc.agentIds,
    });
    const next: Partial<KnowledgeDoc> = { title: clean.title, folder: clean.folder, audience: clean.audience, agentIds: clean.agentIds, updatedAt: nowIso(), updatedBy: user.uid };
    if (current !== null || clean.title !== doc.title) {
      // New text (or a new title, which is part of every piece's search words): rebuild the pieces.
      const text = current !== null ? clean.text : (await this.repos.knowledge.chunks(id)).map((c) => c.text).join('\n\n');
      const chunks = this.pieces(id, clean.title, text);
      await this.repos.knowledge.replaceChunks(id, chunks);
      Object.assign(next, { chars: text.length, chunkCount: chunks.length, preview: text.slice(0, 300) });
    }
    await this.repos.knowledge.update(id, next);
    this.cache = null;
    return { ...doc, ...next };
  }

  async remove(user: AppUser, id: string) {
    if (!this.canManage(user)) throw forbidden('Only Admins can remove company knowledge');
    const doc = await this.repos.knowledge.get(id);
    if (!doc) throw notFound('Document not found');
    await this.repos.knowledge.delete(id);
    this.cache = null;
    return doc;
  }

  /**
   * Finds the best matching pieces the person (and, if given, the AI employee) may read.
   * Keyword search with BM25-style scoring: rare words count more, long pieces less.
   */
  async search(user: AppUser, query: string, opts: { agentId?: string; limit?: number } = {}): Promise<KnowledgeHit[]> {
    const qTerms = [...new Set(searchTerms(query))].slice(0, 30);
    if (!qTerms.length) return [];
    const docs = new Map((await this.allDocs()).filter((d) => canReadKnowledge(user, d) && (!opts.agentId || agentMayUseKnowledge(opts.agentId, d))).map((d) => [d.docId, d]));
    if (!docs.size) return [];
    const found = (await this.repos.knowledge.findChunks(qTerms, 400)).filter((c) => docs.has(c.docId));
    if (!found.length) return [];
    const total = [...docs.values()].reduce((n, d) => n + d.chunkCount, 0) || found.length;
    const df = new Map<string, number>();
    const tfs = found.map((c) => {
      const words = searchTerms(c.text);
      const tf = new Map<string, number>();
      for (const w of words) if (qTerms.includes(w)) tf.set(w, (tf.get(w) ?? 0) + 1);
      for (const t of qTerms) if (c.terms.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);
      return { c, tf, len: words.length || 1 };
    });
    const avg = tfs.reduce((n, x) => n + x.len, 0) / tfs.length;
    const k1 = 1.2;
    const b = 0.75;
    const hits = tfs.map(({ c, tf, len }) => {
      const doc = docs.get(c.docId)!;
      const titleTerms = new Set(searchTerms(doc.title));
      let score = 0;
      let matched = 0;
      for (const t of qTerms) {
        const n = df.get(t) ?? 0;
        if (!c.terms.includes(t)) continue;
        matched++;
        const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5));
        const f = tf.get(t) ?? 0.5; // only in the title
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avg)));
        if (titleTerms.has(t)) score += idf * 0.5;
      }
      // Pieces that match more of the question rank higher.
      score *= 0.5 + matched / qTerms.length;
      return { docId: c.docId, title: doc.title, folder: doc.folder, index: c.index, of: doc.chunkCount, text: c.text, score: Math.round(score * 100) / 100 };
    });
    return hits.sort((a, b2) => b2.score - a.score).slice(0, opts.limit ?? 5);
  }

  /** One piece (plus the next one or two), for an AI that wants to read on. */
  async readPart(user: AppUser, agentId: string, docId: string, part: number) {
    const doc = await this.repos.knowledge.get(docId);
    if (!doc || !canReadKnowledge(user, doc) || !agentMayUseKnowledge(agentId, doc)) throw new Error('That document does not exist or you may not read it.');
    const chunks = await this.repos.knowledge.chunks(docId);
    const from = Math.max(0, Math.min(part - 1, chunks.length - 1));
    return { doc, from: from + 1, to: Math.min(from + 3, chunks.length), of: chunks.length, text: chunks.slice(from, from + 3).map((c) => c.text).join('\n\n') };
  }

  private pieces(docId: string, title: string, text: string): KnowledgeChunk[] {
    const titleTerms = searchTerms(title);
    return chunkText(text, KNOWLEDGE_LIMITS.chunkChars).map((t, index) => ({
      docId,
      index,
      text: t,
      terms: [...new Set([...titleTerms, ...searchTerms(t)])].slice(0, 400),
    }));
  }

  private check(i: KnowledgeInput) {
    const title = i.title.trim().slice(0, KNOWLEDGE_LIMITS.maxTitle);
    if (!title) throw badRequest('Give the document a title');
    const folder = i.folder.trim().replace(/\s+/g, ' ').slice(0, KNOWLEDGE_LIMITS.maxFolder);
    const text = i.text.replace(/\r\n?/g, '\n').trim();
    if (!text) throw badRequest('The document has no text');
    if (text.length > KNOWLEDGE_LIMITS.maxChars) throw badRequest(`The text is too long (max ${KNOWLEDGE_LIMITS.maxChars.toLocaleString()} characters). Split it into smaller documents.`);
    const audience: KnowledgeAudience = {
      everyone: !!i.audience.everyone,
      departments: [...new Set(i.audience.departments.map((d) => d.trim()).filter(Boolean))].slice(0, 50),
      roles: [...new Set(i.audience.roles.filter((r) => (ROLES as readonly string[]).includes(r)))],
    };
    if (!audience.everyone && !audience.departments.length && !audience.roles.length) throw badRequest('Choose who can read it: everyone, or some departments or roles');
    return { title, folder, text, audience, agentIds: [...new Set(i.agentIds)].slice(0, 100) };
  }
}

/** The AI's tools for Company Knowledge (read only, risk level 1). */
export function knowledgeTools(svc: KnowledgeService, user: AppUser, agentId: string): AgentTool[] {
  return [
    {
      name: 'search_knowledge',
      description:
        'Search Company Knowledge (SOPs, house rules, policies, price lists, guides written by the company). Use it BEFORE answering questions about how Widebed does things. Quote what the document says and name the document; if nothing is found, say so — never invent a policy.',
      input: '{ "query": "a few key words, e.g. check-in time late checkout fee" }',
      label: (i) => `Looking in Company Knowledge: ${String(i?.query ?? '').slice(0, 60)}`,
      target: 'Company Knowledge',
      async run(input) {
        const query = String(input?.query ?? '').slice(0, 300);
        if (!query.trim()) throw new Error('Give a query');
        const hits = await svc.search(user, query, { agentId, limit: 5 });
        if (!hits.length) return 'Nothing found in Company Knowledge for that. Try other words, or tell the person there is no document about it.';
        return hits.map((h) => `[doc ${h.docId}, part ${h.index + 1} of ${h.of}] “${h.title}”${h.folder ? ` (folder: ${h.folder})` : ''}\n${h.text}`).join('\n\n---\n\n');
      },
    },
    {
      name: 'read_knowledge',
      description: 'Read more of one Company Knowledge document (3 parts at a time), e.g. to see the rest of a procedure found with search_knowledge.',
      input: '{ "docId": "kdoc_…", "part": 1 }',
      label: () => 'Reading a Company Knowledge document',
      target: 'Company Knowledge',
      async run(input) {
        const r = await svc.readPart(user, agentId, String(input?.docId ?? ''), Number(input?.part ?? 1) || 1);
        return `“${r.doc.title}” — parts ${r.from}–${r.to} of ${r.of}\n\n${r.text}`;
      },
    },
  ];
}
