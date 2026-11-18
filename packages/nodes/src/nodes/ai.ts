import { z } from 'zod';
import type { Item } from '@widebed/shared';
import { defineNode, NodeError, requireService, type NodeExecutionContext } from '../types.js';

/**
 * AI nodes. They use an "AI service" connection (OpenAI, Claude or Gemini) chosen
 * on the node. Written for non-technical users: you describe the job in plain words.
 * AI answers can be wrong — the docs say so, and nothing here sends or deletes on its own.
 */

const MAX_TEXT = 30_000; // characters sent per item, so a huge email cannot run up the bill

type Ctx = NodeExecutionContext<any>;

function aiFor(ctx: Ctx) {
  if (!ctx.node.credentialId) throw new NodeError('Choose an AI connection for this node (Credentials → AI service)', { code: 'NO_CREDENTIAL' });
  const ask = requireService(ctx.services, 'ai', 'AI access');
  const id = ctx.node.credentialId;
  return (req: Parameters<typeof ask>[1]) => ask(id, { ...req, signal: ctx.signal });
}

const asText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v));
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n[…cut: the text was longer than ${MAX_TEXT} characters]` : s);

/** Reads the first JSON object in an AI answer (some models wrap it in ``` fences). */
export function parseAiJson(text: string): Record<string, unknown> {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new NodeError('The AI did not answer in the expected format. Try again, or describe the job more clearly.', { code: 'AI_FORMAT', retryable: true });
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    throw new NodeError('The AI did not answer in the expected format. Try again, or describe the job more clearly.', { code: 'AI_FORMAT', retryable: true });
  }
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;
// Caps, not targets: newer “thinking” models spend part of this before they write, so keep room.
const LENGTHS = { short: 3000, medium: 5000, long: 10000 } as const;

/* ------------------------------------------------------------------ AI Chat */

export const aiChat = defineNode({
  descriptor: {
    type: 'ai.chat',
    version: 1,
    displayName: 'AI Write / Answer',
    description: 'Ask AI to write, summarise, translate or answer — once per item.',
    category: 'ai',
    icon: 'message-square',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    credentialProvider: 'ai_provider',
    fields: [
      {
        key: 'prompt',
        label: 'What should the AI do?',
        type: 'text',
        required: true,
        expressions: true,
        default: 'Write a short, friendly reply to this guest email. Use the same language as the guest.\n\n{{ $json.body }}',
        help: 'Write it like a message to a colleague. Insert data with {{ }}, e.g. {{ $json.body }} for an email’s text.',
      },
      {
        key: 'rules',
        label: 'House rules for the AI (optional)',
        type: 'text',
        expressions: true,
        default: '',
        placeholder: 'You work for Widebed, a short-term rental company in Malaysia. Be polite and brief. Never promise refunds.',
      },
      {
        key: 'length',
        label: 'Answer length',
        type: 'select',
        default: 'medium',
        options: [
          { label: 'Short (a few sentences)', value: 'short' },
          { label: 'Medium (a few paragraphs)', value: 'medium' },
          { label: 'Long (a page or more)', value: 'long' },
        ],
      },
      { key: 'saveAs', label: 'Save the answer as', type: 'string', default: 'answer', help: 'Next steps use it as {{ $json.answer }}.' },
    ],
    inputSchema: { description: 'One AI request per item.' },
    outputSchema: { description: 'The same item plus the AI’s answer.', example: [{ json: { from: 'guest@example.com', body: '…', answer: 'Dear Ana, thank you for…' } }] },
    retryable: true,
    available: true,
    docs: [
      '### AI Write / Answer',
      'Describe the job in plain words. The answer is added to each item as **answer** (or the name you choose).',
      '',
      '**Examples**',
      '- “Summarise this complaint in 2 sentences: {{ $json.body }}”',
      '- “Translate to English: {{ $json.message }}”',
      '- “Write a friendly reminder to {{ $json.Name }} that rent of {{ $json.Amount }} is due.”',
      '',
      'AI can make mistakes. For emails to guests, consider sending the draft to your team first instead of straight to the guest.',
      'Each item is one paid AI request; very long texts are cut at 30 000 characters.',
    ].join('\n'),
  },
  configSchema: z.object({
    prompt: z.string({ required_error: 'Describe what the AI should do' }).min(1, 'Describe what the AI should do'),
    rules: z.string().default(''),
    length: z.enum(['short', 'medium', 'long']).default('medium'),
    saveAs: z.string().regex(FIELD_NAME, 'Use letters, numbers and _ only (e.g. answer)').default('answer'),
  }),
  async execute(ctx) {
    const ask = aiFor(ctx);
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const c = ctx.resolve(ctx.config, ctx.items[i], i) as any;
      const res = await ask({ prompt: clip(asText(c.prompt)), system: asText(c.rules) || undefined, maxTokens: LENGTHS[c.length as keyof typeof LENGTHS] });
      out.push({ json: { ...ctx.items[i]!.json, [c.saveAs]: res.text.trim() } });
    }
    return { outputs: { main: out } };
  },
});

/* -------------------------------------------------------------- AI Classify */

export const aiClassify = defineNode({
  descriptor: {
    type: 'ai.classify',
    version: 1,
    displayName: 'AI Sort into Categories',
    description: 'AI reads each item and sends it to the matching category’s output.',
    category: 'ai',
    icon: 'tags',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [],
    dynamicOutputs: { from: 'categories', labelKey: 'label', fallback: { id: 'otherwise', label: 'Other' } },
    credentialProvider: 'ai_provider',
    fields: [
      { key: 'text', label: 'Text to read', type: 'text', required: true, expressions: true, default: 'Subject: {{ $json.subject }}\n\n{{ $json.body }}' },
      {
        key: 'categories',
        label: 'Categories',
        type: 'cases',
        required: true,
        default: [
          { id: 'c_booking', label: 'Booking question', value: 'Questions about availability, prices, check-in or check-out times' },
          { id: 'c_complaint', label: 'Complaint', value: 'Something is broken, dirty or the guest is unhappy' },
          { id: 'c_cancel', label: 'Cancellation', value: 'The guest wants to cancel or change dates' },
        ],
        columnLabels: ['Category', 'What belongs here (helps the AI)'],
        keyPlaceholder: 'Complaint',
        valuePlaceholder: 'Something is broken or dirty',
        addLabel: 'Add category',
        help: 'Each category gets its own output. Anything that fits none goes to “Other”.',
      },
      { key: 'instructions', label: 'Extra instructions (optional)', type: 'text', expressions: true, default: '', placeholder: 'If the guest mentions both a complaint and a cancellation, choose Cancellation.' },
    ],
    inputSchema: { description: 'Any items with text to sort.' },
    outputSchema: { description: 'The same item, with the chosen category and a short reason, on that category’s output.', example: [{ json: { subject: 'Aircon broken', category: 'Complaint', reason: 'Guest reports a broken air-conditioner' } }] },
    retryable: true,
    available: true,
    docs: [
      '### AI Sort into Categories',
      'Like a Switch, but AI decides. Give each category a short description so the AI knows what belongs there.',
      'Connect each output to what should happen, e.g. *Complaint* → email the operations team.',
      '',
      'The item gets two new fields: **category** and **reason** (one sentence explaining the choice).',
      'AI can be wrong — avoid using it alone for decisions that cost money.',
    ].join('\n'),
  },
  configSchema: z.object({
    text: z.string({ required_error: 'Choose the text the AI should read' }).min(1, 'Choose the text the AI should read'),
    categories: z
      .array(z.object({ id: z.string().min(1).max(40), label: z.string().trim().min(1, 'Every category needs a name').max(60), value: z.unknown() }))
      .min(2, 'Add at least two categories')
      .max(15, 'At most 15 categories'),
    instructions: z.string().default(''),
  }),
  async execute(ctx) {
    const ask = aiFor(ctx);
    const outputs: Record<string, Item[]> = { otherwise: [] };
    for (const c of ctx.config.categories) outputs[c.id] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const c = ctx.resolve(ctx.config, ctx.items[i], i) as any;
      const list = (c.categories as { id: string; label: string; value: unknown }[]).map((x) => `- ${x.label}${asText(x.value) ? `: ${asText(x.value)}` : ''}`).join('\n');
      const res = await ask({
        system: 'You sort messages for a short-term rental company into categories.',
        prompt: [
          'Choose the ONE category that fits the text best.',
          `Categories:\n${list}\n- Other: fits none of the above`,
          asText(c.instructions),
          'Answer as JSON: {"category": "<exact category name>", "reason": "<one short sentence>"}',
          `Text:\n"""\n${clip(asText(c.text))}\n"""`,
        ].filter(Boolean).join('\n\n'),
        json: true,
        maxTokens: 3000,
      });
      const answer = parseAiJson(res.text);
      const chosen = String(answer.category ?? '').trim().toLowerCase();
      const match = (c.categories as { id: string; label: string }[]).find((x) => x.label.trim().toLowerCase() === chosen);
      const json = { ...ctx.items[i]!.json, category: match ? match.label : 'Other', reason: String(answer.reason ?? '') };
      outputs[match ? match.id : 'otherwise']!.push({ json });
    }
    return { outputs };
  },
});

/* --------------------------------------------------------------- AI Extract */

export const aiExtract = defineNode({
  descriptor: {
    type: 'ai.extract',
    version: 1,
    displayName: 'AI Pull Out Details',
    description: 'AI reads a text (e.g. a booking email) and fills in the fields you list.',
    category: 'ai',
    icon: 'scan-text',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    credentialProvider: 'ai_provider',
    fields: [
      { key: 'text', label: 'Text to read', type: 'text', required: true, expressions: true, default: '{{ $json.body }}' },
      {
        key: 'fields',
        label: 'Details to find',
        type: 'keyValue',
        required: true,
        default: [
          { key: 'guestName', value: 'Full name of the guest' },
          { key: 'checkIn', value: 'Check-in date as YYYY-MM-DD' },
          { key: 'checkOut', value: 'Check-out date as YYYY-MM-DD' },
          { key: 'property', value: 'Name of the property or room' },
        ],
        keyPlaceholder: 'Field name, e.g. guestName',
        valuePlaceholder: 'What it is, e.g. Full name of the guest',
        help: 'Field names: letters and numbers, no spaces. Next steps use them as {{ $json.guestName }}.',
      },
    ],
    inputSchema: { description: 'Any items with text to read.' },
    outputSchema: { description: 'The same item plus one field per detail (empty when not found).', example: [{ json: { subject: 'New booking', guestName: 'Ana Lee', checkIn: '2026-12-01', checkOut: '2026-12-04', property: 'Sunrise Suite A-12' } }] },
    retryable: true,
    available: true,
    docs: [
      '### AI Pull Out Details',
      'Turns free text into tidy fields. Typical use: booking emails from OTAs → a row in Google Sheets.',
      '',
      'Describe each field clearly, including the format you want (e.g. “date as YYYY-MM-DD”, “number only”).',
      'If a detail is not in the text, the field is left empty — the AI is told not to guess. Still, check important values.',
    ].join('\n'),
  },
  configSchema: z.object({
    text: z.string({ required_error: 'Choose the text the AI should read' }).min(1, 'Choose the text the AI should read'),
    fields: z
      .array(z.object({ key: z.string().trim().regex(FIELD_NAME, 'Field names: letters, numbers and _ only (e.g. guestName)'), value: z.unknown() }))
      .min(1, 'Add at least one detail to find')
      .max(30, 'At most 30 details'),
  }),
  async execute(ctx) {
    const ask = aiFor(ctx);
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const c = ctx.resolve(ctx.config, ctx.items[i], i) as any;
      const fields = c.fields as { key: string; value: unknown }[];
      const res = await ask({
        system: 'You extract details from text for a short-term rental company. Never invent information.',
        prompt: [
          'Read the text and fill in these fields:',
          fields.map((f) => `- ${f.key}: ${asText(f.value) || f.key}`).join('\n'),
          'Use an empty string "" for anything the text does not say. Answer as one JSON object with exactly these keys.',
          `Text:\n"""\n${clip(asText(c.text))}\n"""`,
        ].join('\n\n'),
        json: true,
        maxTokens: 5000,
      });
      const answer = parseAiJson(res.text);
      const found = Object.fromEntries(fields.map((f) => {
        const v = answer[f.key];
        return [f.key, v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : v];
      }));
      out.push({ json: { ...ctx.items[i]!.json, ...found } });
    }
    return { outputs: { main: out } };
  },
});

/* ----------------------------------------------------------------- AI Agent */

export const aiAgent = defineNode({
  descriptor: {
    type: 'ai.agent',
    version: 1,
    displayName: 'AI Agent',
    description: 'Give the Widebed Assistant a job to do on its own — it can read PMS data, run workflows and use saved websites.',
    category: 'ai',
    icon: 'bot',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    fields: [
      {
        key: 'goal',
        label: 'The job, in plain words',
        type: 'text',
        required: true,
        expressions: true,
        default: 'Open the myTNB website, sign in, and list every unpaid bill with its account number, amount and due date. Download each bill PDF.',
        help: 'Describe the result you want. You can insert data with {{ }}. The answer is saved as {{ $json.answer }}.',
      },
      { key: 'agent', label: 'AI employee (optional)', type: 'string', default: '', placeholder: 'e.g. Finance Assistant', help: 'Name of an AI employee from AI Staff. It works with its own instructions and memory. Leave empty for the Widebed Assistant.' },
      { key: 'usePms', label: 'May read Widebed PMS data', type: 'boolean', default: true },
      { key: 'useWorkflows', label: 'May run published workflows', type: 'boolean', default: false },
      { key: 'websites', label: 'Saved websites it may use (comma-separated names)', type: 'string', default: '', placeholder: 'myTNB', help: 'Names of “Website login” connections. Leave empty for no browser.' },
      {
        key: 'allowActions',
        label: 'Let it act without asking (run workflows, click risky buttons)',
        type: 'boolean',
        default: false,
        help: 'Off (recommended): actions that normally need your approval are refused in automatic runs, and the agent explains what it could not do.',
      },
      { key: 'saveAs', label: 'Save the answer as', type: 'string', default: 'answer' },
    ],
    inputSchema: { description: 'One agent run per item.' },
    outputSchema: {
      description: 'The same item plus the agent’s answer, the steps it took and any files it downloaded.',
      example: [{ json: { answer: '3 unpaid bills: …', agentSteps: ['Opening myTNB', 'Signing in', 'Reading the page'], files: [{ name: 'bill-2026-10.pdf' }] } }],
    },
    retryable: false,
    available: true,
    docs: [
      '### AI Agent',
      'Runs the **Widebed Assistant** on its own, as the owner of this workflow, with the assistant’s AI service (set up on the AI Agents page).',
      'Combine it with a Schedule Trigger for jobs like “every 1st of the month, collect the TNB bills” and a Gmail step to email the answer.',
      '',
      'Nobody can approve actions or type an OTP during an automatic run. Websites that always ask for a code by SMS will not work here — use the Assistant chat for those.',
      'Every run costs AI requests; long jobs can take a few minutes.',
    ].join('\n'),
  },
  configSchema: z.object({
    goal: z.string({ required_error: 'Describe the job' }).min(1, 'Describe the job'),
    usePms: z.boolean().default(true),
    useWorkflows: z.boolean().default(false),
    websites: z.string().default(''),
    allowActions: z.boolean().default(false),
    agent: z.string().default(''),
    saveAs: z.string().regex(FIELD_NAME, 'Use letters, numbers and _ only (e.g. answer)').default('answer'),
  }),
  async execute(ctx) {
    const agent = requireService(ctx.services, 'agent', 'The Widebed Assistant');
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const c = ctx.resolve(ctx.config, ctx.items[i], i) as any;
      const res = await agent({
        goal: clip(asText(c.goal)),
        usePms: !!c.usePms,
        useWorkflows: !!c.useWorkflows,
        websites: String(c.websites ?? '').split(',').map((s: string) => s.trim()).filter(Boolean),
        allowActions: !!c.allowActions,
        ...(String(c.agent ?? '').trim() ? { agent: String(c.agent).trim() } : {}),
        signal: ctx.signal,
      });
      out.push({ json: { ...ctx.items[i]!.json, [c.saveAs]: res.answer, agentSteps: res.steps, files: res.files } });
    }
    return { outputs: { main: out } };
  },
});
