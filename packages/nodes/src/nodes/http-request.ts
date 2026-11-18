import { z } from 'zod';
import type { Item } from '@widebed/shared';
import { defineNode, NodeError } from '../types.js';
import { SsrfError } from '../http/safe-http.js';

const keyValue = z.array(z.object({ key: z.string(), value: z.unknown() })).default([]);

/** Header names that must come from a credential, not a plain workflow field. */
const SENSITIVE_HEADERS = /^(authorization|proxy-authorization|cookie|x-api-key|api-key)$/i;

export const httpRequest = defineNode({
  descriptor: {
    type: 'data.httpRequest',
    version: 1,
    displayName: 'HTTP Request',
    description: 'Call any REST API and use the response in the next nodes.',
    category: 'data',
    icon: 'globe',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    fields: [
      {
        key: 'method',
        label: 'Method',
        type: 'select',
        default: 'GET',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => ({ label: m, value: m })),
      },
      { key: 'url', label: 'URL', type: 'string', required: true, expressions: true, placeholder: 'https://api.example.com/items/{{ $json.id }}' },
      { key: 'query', label: 'Query parameters', type: 'keyValue', expressions: true, default: [] },
      { key: 'headers', label: 'Headers', type: 'keyValue', expressions: true, default: [], help: 'Authorization and API-key headers are not allowed here — they will come from Credentials (Phase 3).' },
      {
        key: 'bodyType',
        label: 'Body',
        type: 'select',
        default: 'none',
        options: [
          { label: 'None', value: 'none' },
          { label: 'JSON', value: 'json' },
          { label: 'Raw text', value: 'text' },
        ],
      },
      { key: 'body', label: 'Body content', type: 'code', expressions: true, showIf: { key: 'bodyType', equals: ['json', 'text'] }, default: '' },
      { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 15000 },
      { key: 'failOnHttpError', label: 'Fail on 4xx / 5xx responses', type: 'boolean', default: true },
    ],
    inputSchema: { description: 'Any items. One request is sent per incoming item.' },
    outputSchema: {
      description: 'One item per request with status, headers and parsed body.',
      example: [{ json: { status: 200, headers: { 'content-type': 'application/json' }, body: { id: 1 } } }],
    },
    retryable: true,
    available: true,
    docs: [
      '### HTTP Request',
      'Sends one request **per incoming item**, so `{{ $json.id }}` in the URL is resolved for each item.',
      '',
      '**Security**',
      '- Requests to private, loopback and cloud-metadata addresses are blocked (SSRF protection).',
      '  An IT admin can allow specific internal hosts with `HTTP_ALLOWED_PRIVATE_HOSTS`.',
      '- Responses larger than the configured limit are rejected.',
      '- Secrets must not be typed into headers. Credential-based auth arrives with the Integration Hub.',
      '',
      '**Retries**: network errors, timeouts, 429 and 5xx responses are retryable. Other 4xx are not.',
    ].join('\n'),
  },
  configSchema: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
    url: z.string().min(1, 'URL is required'),
    query: keyValue,
    headers: keyValue.refine(
      (list) => !list.some((h) => SENSITIVE_HEADERS.test(h.key.trim())),
      'Authorization / API-key headers must come from a credential, not a plain field',
    ),
    bodyType: z.enum(['none', 'json', 'text']).default('none'),
    body: z.string().default(''),
    timeoutMs: z.coerce.number().int().min(100).max(120000).default(15000),
    failOnHttpError: z.boolean().default(true),
  }),
  async execute(ctx) {
    const out: Item[] = [];
    const items = ctx.items.length ? ctx.items : [{ json: {} }];
    for (let i = 0; i < items.length; i++) {
      if (ctx.signal.aborted) throw new NodeError('Execution cancelled', { code: 'CANCELLED' });
      const item = items[i];
      const cfg = ctx.config;
      const rawUrl = String(ctx.resolve(cfg.url, item, i) ?? '');
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        throw new NodeError(`Invalid URL: "${rawUrl}"`, { code: 'INVALID_URL' });
      }
      for (const q of cfg.query) {
        if (q.key) url.searchParams.append(String(ctx.resolve(q.key, item, i)), String(ctx.resolve(q.value, item, i) ?? ''));
      }
      const headers: Record<string, string> = {};
      for (const h of cfg.headers) {
        if (h.key) headers[String(ctx.resolve(h.key, item, i))] = String(ctx.resolve(h.value, item, i) ?? '');
      }
      let body: string | undefined;
      if (cfg.bodyType !== 'none' && cfg.method !== 'GET' && cfg.method !== 'HEAD') {
        const resolved = ctx.resolve(cfg.body, item, i);
        if (cfg.bodyType === 'json') {
          // Accept an object produced by a {{ }} expression, or JSON text.
          if (typeof resolved === 'string') {
            try {
              body = JSON.stringify(JSON.parse(resolved || '{}'));
            } catch {
              throw new NodeError('Body is not valid JSON', { code: 'INVALID_BODY' });
            }
          } else {
            body = JSON.stringify(resolved ?? {});
          }
          headers['content-type'] ??= 'application/json';
        } else {
          body = typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
          headers['content-type'] ??= 'text/plain';
        }
      }

      let res;
      try {
        res = await ctx.services.http.request({
          method: cfg.method,
          url: url.toString(),
          headers,
          body,
          timeoutMs: cfg.timeoutMs,
          signal: ctx.signal,
        });
      } catch (err) {
        if (err instanceof SsrfError) throw new NodeError(err.message, { code: 'SSRF_BLOCKED', retryable: false });
        const msg = err instanceof Error ? err.message : String(err);
        throw new NodeError(`Request failed: ${msg}`, { code: 'NETWORK_ERROR', retryable: !ctx.signal.aborted });
      }

      let parsed: unknown = res.body;
      const type = res.headers['content-type'] ?? '';
      if (type.includes('json') && res.body) {
        try {
          parsed = JSON.parse(res.body);
        } catch {
          /* keep raw text */
        }
      }
      if (cfg.failOnHttpError && res.status >= 400) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new NodeError(`HTTP ${res.status} ${res.statusText}`.trim(), {
          code: 'HTTP_ERROR',
          retryable,
          details: { status: res.status, body: typeof parsed === 'string' ? parsed.slice(0, 500) : parsed },
        });
      }
      out.push({ json: { status: res.status, statusText: res.statusText, headers: res.headers, body: parsed } });
    }
    return { outputs: { main: out } };
  },
});
