import { z } from 'zod';
import { defineNode } from '../types.js';

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
        ],
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
    ].join('\n'),
  },
  configSchema: z.object({
    method: z.enum(['POST', 'GET', 'PUT', 'PATCH', 'DELETE']).default('POST'),
    requireSignature: z.boolean().default(false),
    responseMode: z.enum(['accepted']).default('accepted'),
  }),
  async execute(ctx) {
    // The API layer builds the request item and passes it in as trigger input.
    return { outputs: { main: ctx.items.length ? ctx.items : [{ json: {} }] } };
  },
});
