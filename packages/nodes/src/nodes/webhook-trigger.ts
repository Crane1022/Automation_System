import { z } from 'zod';
import { defineNode } from '../types.js';

/** "https://a.com, https://b.com/" → ["https://a.com", "https://b.com"]; null when one is not a web address. */
export function parseOrigins(text: string): string[] | null {
  const out: string[] = [];
  for (const part of text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)) {
    if (part === '*') {
      out.push('*');
      continue;
    }
    try {
      const u = new URL(part);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      out.push(u.origin);
    } catch {
      return null;
    }
  }
  return out;
}

export const webhookTrigger = defineNode({
  descriptor: {
    type: 'trigger.webhook',
    version: 1,
    displayName: 'Webhook Trigger',
    description: 'Start the workflow when an external system calls a unique URL.',
    category: 'trigger',
    icon: 'webhook',
    isTrigger: true,
    inputs: [],
    outputs: [{ id: 'main' }],
    fields: [
      {
        key: 'method',
        label: 'HTTP method',
        type: 'select',
        default: 'POST',
        options: ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ label: m, value: m })),
      },
      {
        key: 'requireSignature',
        label: 'Require HMAC signature',
        type: 'boolean',
        default: false,
        help: 'Callers must send X-Widebed-Signature: sha256=<hex HMAC of the raw body> using the signing secret shown when the endpoint is created.',
      },
      {
        key: 'responseMode',
        label: 'Response',
        type: 'select',
        default: 'accepted',
        options: [
          { label: 'Respond immediately (202 + execution id)', value: 'accepted' },
          { label: 'Wait and send back the reply (use a “Respond to Webhook” step)', value: 'reply' },
        ],
        help: 'Chat boxes on a website need “Wait and send back the reply”, so the visitor sees the answer.',
      },
      {
        key: 'allowedOrigins',
        label: 'Websites that may call it from a browser (chat boxes)',
        type: 'string',
        default: '',
        placeholder: 'https://www.widebed.com, https://widebed.com',
        help: 'Only needed for a chat box on a website. Calls from other websites are refused. Use * to allow any website (e.g. when a page builder runs the code in its own frame). Leave empty for system-to-system calls (e.g. GoHighLevel).',
      },
      {
        key: 'testData',
        label: 'Sample request for “Test run” (JSON)',
        type: 'json',
        default: '',
        placeholder: '{ "message": "Hi, is parking free?", "sessionId": "test-1" }',
        help: 'Used only by Test run and Test node in the editor, as if a caller had sent it. Later steps read it as {{ $json.body.… }}.',
      },
    ],
    inputSchema: { description: 'No input. The HTTP request becomes the output item.' },
    outputSchema: {
      description: 'A single item describing the incoming request.',
      example: [{ json: { body: { bookingId: 'B-102' }, query: {}, headers: { 'content-type': 'application/json' }, method: 'POST' } }],
    },
    retryable: true,
    available: true,
    docs: [
      '### Webhook Trigger',
      'When the workflow is **published and active**, a webhook endpoint is created.',
      'The URL contains a random token that is shown once; only its hash is stored.',
      '',
      '- Send JSON to the URL with the configured method.',
      '- Add an `Idempotency-Key` header to make retries from the caller safe — the same key never starts two executions.',
      '- With *Require HMAC signature*, sign the raw body with the signing secret (HMAC-SHA256, hex) and send it as `X-Widebed-Signature: sha256=<hex>`.',
      '',
      'Access request data in later nodes with `{{ $json.body.field }}`.',
      '',
      '**Website chat box**: set *Response* to “Wait and send back the reply”, list your website under *Websites that may call it*, and end the workflow with a **Respond to Webhook** step. The caller gets that step’s answer (waits up to 30 seconds).',
    ].join('\n'),
  },
  configSchema: z.object({
    method: z.enum(['POST', 'GET', 'PUT', 'PATCH', 'DELETE']).default('POST'),
    requireSignature: z.boolean().default(false),
    responseMode: z.enum(['accepted', 'reply']).default('accepted'),
    testData: z.unknown().optional(),
    allowedOrigins: z
      .string()
      .default('')
      .refine((v) => parseOrigins(v) !== null, 'List websites as full addresses, e.g. https://www.widebed.com (comma-separated), or * for any website'),
  }),
  async execute(ctx) {
    // The API layer builds the request item and passes it in as trigger input.
    return { outputs: { main: ctx.items.length ? ctx.items : [{ json: {} }] } };
  },
});
