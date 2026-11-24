import type { FileRef, FileStoreAccess } from '@widebed/nodes';
import type { Repositories, StoredFile } from '../repositories/types.js';
import { randomToken } from '../lib/crypto.js';

/**
 * Files kept for a few days for workflows: photos a website chat box sends to a webhook,
 * and pictures made by the AI Picture step.
 *
 * Each file has an unguessable id (192 random bits), which is also its public link
 * (/api/files/<id>), so a chat box can show a picture without signing in.
 * A workflow can only read its own files.
 */

export const FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export class FileService {
  constructor(
    private readonly repos: Repositories,
    private readonly opts: { publicBaseUrl: string; retentionDays: number },
  ) {}

  url(fileId: string) {
    return `${this.opts.publicBaseUrl.replace(/\/$/, '')}/api/files/${fileId}`;
  }

  async save(owner: { workflowId: string; executionId: string | null }, data: Uint8Array, meta: { name: string; mimeType: string }): Promise<FileRef> {
    if (!FILE_TYPES.includes(meta.mimeType)) throw new Error(`Files of type ${meta.mimeType} are not kept`);
    if (data.byteLength > MAX_FILE_BYTES) throw new Error('The file is larger than 8 MB');
    const now = Date.now();
    const stored: StoredFile = {
      fileId: `file_${randomToken(24)}`,
      workflowId: owner.workflowId,
      executionId: owner.executionId,
      name: meta.name.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file',
      mimeType: meta.mimeType,
      size: data.byteLength,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.opts.retentionDays * 86400_000).toISOString(),
    };
    await this.repos.files.save(stored, Buffer.from(data));
    return { fileId: stored.fileId, name: stored.name, mimeType: stored.mimeType, size: stored.size, url: this.url(stored.fileId) };
  }

  /** For the public link: any file, by its secret id. */
  async read(fileId: string) {
    if (!/^file_[A-Za-z0-9_-]{20,60}$/.test(fileId)) return null;
    return this.repos.files.get(fileId);
  }

  /** What one run of a workflow may do with files. */
  accessFor(workflowId: string, executionId: string): FileStoreAccess {
    return {
      save: (data, meta) => this.save({ workflowId, executionId }, data, meta),
      load: async (fileId) => {
        const f = await this.read(fileId);
        if (!f || f.meta.workflowId !== workflowId) return null;
        return { data: f.data, name: f.meta.name, mimeType: f.meta.mimeType };
      },
    };
  }
}
