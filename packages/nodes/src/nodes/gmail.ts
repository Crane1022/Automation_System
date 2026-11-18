import { z } from 'zod';
import type { Item } from '@widebed/shared';
import { defineNode, NodeError, requireService, type NodeExecutionContext } from '../types.js';

/**
 * Gmail nodes call the Gmail REST API directly with an access token from a
 * connected Google account (OAuth). Tokens are refreshed by the platform.
 */

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function token(ctx: NodeExecutionContext<any>) {
  if (!ctx.node.credentialId) throw new NodeError('Choose a Google account for this node', { code: 'NO_CREDENTIAL' });
  return requireService(ctx.services, 'googleToken', 'Google access')(ctx.node.credentialId);
}

async function gmail(ctx: NodeExecutionContext<any>, accessToken: string, method: string, path: string, body?: unknown) {
  const res = await ctx.services.http.request({
    method,
    url: `${API}${path}`,
    headers: { authorization: `Bearer ${accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: ctx.signal,
    timeoutMs: 20000,
  });
  let data: any = null;
  try {
    data = res.body ? JSON.parse(res.body) : null;
  } catch {
    data = res.body;
  }
  if (res.status >= 400) {
    const msg = data?.error?.message ?? `HTTP ${res.status}`;
    throw new NodeError(`Gmail: ${msg}`, { code: 'GMAIL_ERROR', retryable: res.status === 429 || res.status >= 500 });
  }
  return data;
}

/** Encodes a header value with RFC 2047 when it contains non-ASCII characters. */
function encodeHeader(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

/** Rejects header injection (new lines) in address/subject fields. */
function clean(v: unknown, field: string): string {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (/[\r\n]/.test(s)) throw new NodeError(`${field} must not contain line breaks`, { code: 'INVALID_HEADER' });
  return s;
}

export function buildMime(m: { from: string; to: string; cc?: string; bcc?: string; replyTo?: string; subject: string; body: string; html: boolean }): string {
  const lines = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    m.cc ? `Cc: ${m.cc}` : '',
    m.bcc ? `Bcc: ${m.bcc}` : '',
    m.replyTo ? `Reply-To: ${m.replyTo}` : '',
    `Subject: ${encodeHeader(m.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: ${m.html ? 'text/html' : 'text/plain'}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);
  const body = Buffer.from(m.body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return `${lines.join('\r\n')}\r\n\r\n${body}`;
}

/* ---------------------------------------------------------------- Send */

export const gmailSend = defineNode({
  descriptor: {
    type: 'comm.gmailSend',
    version: 1,
    displayName: 'Gmail Send Email',
    description: 'Send an email from a connected Gmail / Google Workspace account.',
    category: 'communication',
    icon: 'mail',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    credentialProvider: 'google_oauth',
    fields: [
      { key: 'to', label: 'To', type: 'string', required: true, expressions: true, placeholder: '{{ $json.email }}', help: 'Separate several addresses with commas.' },
      { key: 'cc', label: 'Cc', type: 'string', expressions: true },
      { key: 'bcc', label: 'Bcc', type: 'string', expressions: true },
      { key: 'subject', label: 'Subject', type: 'string', required: true, expressions: true },
      {
        key: 'format',
        label: 'Format',
        type: 'select',
        default: 'text',
        options: [
          { label: 'Plain text', value: 'text' },
          { label: 'HTML', value: 'html' },
        ],
      },
      { key: 'body', label: 'Message', type: 'text', required: true, expressions: true },
      { key: 'replyTo', label: 'Reply-To', type: 'string', expressions: true },
      { key: 'fromName', label: 'Sender name (optional)', type: 'string', expressions: true, placeholder: 'Widebed', help: 'The name people see, e.g. “Widebed”. The address is the connected Google account.' },
      {
        key: 'keepItem',
        label: 'Pass the item on after sending',
        type: 'boolean',
        default: false,
        help: 'On: the next step gets the same item (all its fields) plus messageId. Use it to mark a record as “Sent” only after the email went out.',
      },
    ],
    inputSchema: { description: 'Any items. One email is sent per item.' },
    outputSchema: { description: 'One item per email: { messageId, threadId, to }.', example: [{ json: { messageId: '18c…', threadId: '18c…', to: 'guest@example.com' } }] },
    retryable: false,
    available: true,
    docs: [
      '### Gmail Send Email',
      'Sends **one email per incoming item** from the connected account.',
      'Automatic retry is off on purpose so a guest never receives the same email twice.',
      'Gmail limits sending (about 2 000 messages/day for Workspace, 500 for personal accounts).',
    ].join('\n'),
  },
  configSchema: z.object({
    to: z.string().min(1, 'Recipient is required'),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    subject: z.string().min(1, 'Subject is required'),
    format: z.enum(['text', 'html']).default('text'),
    body: z.string().min(1, 'Message is required'),
    replyTo: z.string().optional(),
    fromName: z.string().optional(),
    keepItem: z.boolean().default(false),
  }),
  async execute(ctx) {
    const { accessToken, email } = await token(ctx);
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const c = ctx.resolve(ctx.config, ctx.items[i], i);
      const to = clean(c.to, 'To');
      if (!to) throw new NodeError('“To” is empty for this item', { code: 'NO_RECIPIENT' });
      const name = clean(c.fromName, 'Sender name').replace(/["<>]/g, '');
      const mime = buildMime({
        from: name && email ? `${/^[\x20-\x7e]*$/.test(name) ? `"${name}"` : encodeHeader(name)} <${email}>` : email ?? 'me',
        to,
        cc: clean(c.cc, 'Cc'),
        bcc: clean(c.bcc, 'Bcc'),
        replyTo: clean(c.replyTo, 'Reply-To'),
        subject: clean(c.subject, 'Subject'),
        body: String(c.body ?? ''),
        html: c.format === 'html',
      });
      const res = await gmail(ctx, accessToken, 'POST', '/messages/send', { raw: Buffer.from(mime, 'utf8').toString('base64url') });
      out.push({ json: c.keepItem ? { ...ctx.items[i]!.json, messageId: res.id, threadId: res.threadId, sentTo: to } : { messageId: res.id, threadId: res.threadId, to } });
    }
    return { outputs: { main: out } };
  },
});

/* ---------------------------------------------------------------- Read */

function header(msg: any, name: string): string | null {
  return msg?.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

/** Finds the first text/plain (or text/html) part and decodes it. */
export function extractBody(payload: any): string {
  const parts: any[] = [];
  const walk = (p: any) => {
    if (!p) return;
    parts.push(p);
    (p.parts ?? []).forEach(walk);
  };
  walk(payload);
  const pick = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data) ?? parts.find((p) => p.mimeType === 'text/html' && p.body?.data);
  return pick ? Buffer.from(pick.body.data, 'base64url').toString('utf8') : '';
}

export const gmailRead = defineNode({
  descriptor: {
    type: 'comm.gmailRead',
    version: 1,
    displayName: 'Gmail Read Email',
    description: 'Find emails with a Gmail search and read them.',
    category: 'communication',
    icon: 'mail-open',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    credentialProvider: 'google_oauth',
    fields: [
      { key: 'query', label: 'Search', type: 'string', expressions: true, default: 'is:unread newer_than:1d', help: 'Same syntax as the Gmail search box, e.g. from:booking@agoda.com subject:"New booking".' },
      { key: 'maxResults', label: 'Max emails', type: 'number', default: 10, help: '1 – 50' },
      { key: 'includeBody', label: 'Include message text', type: 'boolean', default: true },
      { key: 'markAsRead', label: 'Mark as read', type: 'boolean', default: false },
    ],
    inputSchema: { description: 'Any items. The search runs once per item.' },
    outputSchema: {
      description: 'One item per email.',
      example: [{ json: { id: '18c…', threadId: '18c…', from: 'Agoda <no-reply@agoda.com>', subject: 'New booking', date: 'Fri, 13 Nov 2026 09:00:00 +0800', snippet: '…', body: '…' } }],
    },
    retryable: true,
    available: true,
    docs: [
      '### Gmail Read Email',
      'Uses Gmail search. Combine it with a Schedule Trigger to process new mail regularly,',
      'and turn on *Mark as read* together with `is:unread` so each email is handled once.',
    ].join('\n'),
  },
  configSchema: z.object({
    query: z.string().default(''),
    maxResults: z.coerce.number().int().min(1).max(50).default(10),
    includeBody: z.boolean().default(true),
    markAsRead: z.boolean().default(false),
  }),
  async execute(ctx) {
    const { accessToken } = await token(ctx);
    const out: Item[] = [];
    const items = ctx.items.length ? ctx.items : [{ json: {} }];
    for (let i = 0; i < items.length; i++) {
      const c = ctx.resolve(ctx.config, items[i], i);
      const q = new URLSearchParams({ maxResults: String(c.maxResults) });
      if (c.query) q.set('q', String(c.query));
      const list = await gmail(ctx, accessToken, 'GET', `/messages?${q}`);
      for (const ref of list?.messages ?? []) {
        const fmt = c.includeBody ? 'full' : 'metadata';
        const msg = await gmail(ctx, accessToken, 'GET', `/messages/${ref.id}?format=${fmt}`);
        out.push({
          json: {
            id: msg.id,
            threadId: msg.threadId,
            from: header(msg, 'From'),
            to: header(msg, 'To'),
            subject: header(msg, 'Subject'),
            date: header(msg, 'Date'),
            labels: msg.labelIds ?? [],
            snippet: msg.snippet ?? '',
            ...(c.includeBody ? { body: extractBody(msg.payload).slice(0, 100_000) } : {}),
          },
        });
        if (c.markAsRead) await gmail(ctx, accessToken, 'POST', `/messages/${ref.id}/modify`, { removeLabelIds: ['UNREAD'] });
      }
    }
    return { outputs: { main: out } };
  },
});
