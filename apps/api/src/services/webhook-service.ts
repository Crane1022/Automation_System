import type { NodeRegistry } from '@widebed/nodes';
import type { WorkflowVersion } from '@widebed/shared';
import { SecretBox, hashToken, randomToken } from '../lib/crypto.js';
import { newId, nowIso } from '../lib/ids.js';
import type { Repositories, WebhookEndpoint } from '../repositories/types.js';

/** Returned only once, right after creation or rotation. */
export interface IssuedWebhook {
  webhookId: string;
  nodeId: string;
  url: string;
  signingSecret: string;
}

/**
 * Webhook endpoints.
 * The URL is /hooks/<token>. Only sha256(token) is stored, so a database
 * leak does not reveal callable URLs. The HMAC signing secret is stored
 * encrypted because the server needs it back to verify signatures.
 */
export class WebhookService {
  constructor(
    private repos: Repositories,
    private registry: NodeRegistry,
    private box: SecretBox,
    private publicBaseUrl: string,
  ) {}

  urlFor(token: string) {
    return `${this.publicBaseUrl.replace(/\/$/, '')}/hooks/${token}`;
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
      status: 'active',
      createdAt: nowIso(),
    };
    await this.repos.webhooks.create(ep);
    return { webhookId: ep.webhookId, nodeId, url: this.urlFor(token), signingSecret };
  }
}
