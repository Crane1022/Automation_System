import type { NodeRegistry } from '@widebed/nodes';
import type { WorkflowVersion } from '@widebed/shared';
import { SecretBox, hashToken, randomToken } from '../lib/crypto.js';
import { newId, nowIso } from '../lib/ids.js';
import type { Repositories, WebhookEndpoint } from '../repositories/types.js';

/** Returned after creation or rotation, and to editors of the workflow at any time. */
export interface IssuedWebhook {
  webhookId: string;
  nodeId: string;
  url: string;
  signingSecret: string;
}

/**
 * Webhook endpoints.
 * The URL is /api/hooks/<token> (older /hooks/<token> URLs still work). Calls are matched by sha256(token). The token itself and the HMAC
 * signing secret are stored AES-encrypted (ENCRYPTION_KEY), so people who may edit the workflow
 * can see and copy the URL again; the database alone does not reveal callable URLs.
 */
export class WebhookService {
  constructor(
    private repos: Repositories,
    private registry: NodeRegistry,
    private box: SecretBox,
    private publicBaseUrl: string,
  ) {}

  urlFor(token: string) {
    // /api/hooks/… is forwarded to the API on every hosting setup; /hooks/… keeps working too.
    return `${this.publicBaseUrl.replace(/\/$/, '')}/api/hooks/${token}`;
  }

  /** Makes sure every webhook trigger in the version has an endpoint; removes stale ones. */
  async syncForVersion(version: WorkflowVersion): Promise<IssuedWebhook[]> {
    const hookNodes = version.nodes.filter((n) => n.type === 'trigger.webhook');
    const existing = await this.repos.webhooks.listByWorkflow(version.workflowId);
    const issued: IssuedWebhook[] = [];
    for (const node of hookNodes) {
      if (!existing.some((e) => e.nodeId === node.id)) issued.push(await this.issue(version.workflowId, node.id));
    }
    for (const e of existing) {
      if (!hookNodes.some((n) => n.id === e.nodeId)) await this.repos.webhooks.delete(e.webhookId);
    }
    return issued;
  }

  async rotate(workflowId: string, nodeId: string): Promise<IssuedWebhook> {
    const existing = await this.repos.webhooks.listByWorkflow(workflowId);
    for (const e of existing.filter((x) => x.nodeId === nodeId)) await this.repos.webhooks.delete(e.webhookId);
    return this.issue(workflowId, nodeId);
  }

  async deleteForWorkflow(workflowId: string) {
    for (const e of await this.repos.webhooks.listByWorkflow(workflowId)) await this.repos.webhooks.delete(e.webhookId);
  }

  async resolve(token: string): Promise<WebhookEndpoint | null> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const ep = await this.repos.webhooks.findByTokenHash(hashToken(token));
    return ep && ep.status === 'active' ? ep : null;
  }

  /** URL + signing secret for editors. null when the endpoint was made before URLs were kept (generate a new one). */
  reveal(ep: WebhookEndpoint): IssuedWebhook | null {
    if (!ep.endpointTokenEncrypted) return null;
    return { webhookId: ep.webhookId, nodeId: ep.nodeId, url: this.urlFor(this.box.decrypt(ep.endpointTokenEncrypted)), signingSecret: this.box.decrypt(ep.signingSecretEncrypted) };
  }

  signingSecret(ep: WebhookEndpoint): string {
    return this.box.decrypt(ep.signingSecretEncrypted);
  }

  private async issue(workflowId: string, nodeId: string): Promise<IssuedWebhook> {
    const token = randomToken(24);
    const signingSecret = `whsec_${randomToken(24)}`;
    const ep: WebhookEndpoint = {
      webhookId: newId('wh'),
      workflowId,
      nodeId,
      endpointTokenHash: hashToken(token),
      signingSecretEncrypted: this.box.encrypt(signingSecret),
      endpointTokenEncrypted: this.box.encrypt(token),
      status: 'active',
      createdAt: nowIso(),
    };
    await this.repos.webhooks.create(ep);
    return { webhookId: ep.webhookId, nodeId, url: this.urlFor(token), signingSecret };
  }
}
