import { z } from 'zod';
import type { Item } from '@widebed/shared';
import { defineNode, NodeError, requireService, type AiImage, type NodeExecutionContext } from '../types.js';

/**
 * Pictures for AI steps.
 *
 *  - A Webhook that receives a file upload (multipart/form-data, e.g. a website chat box) keeps each
 *    file for a few days and lists it in `{{ $json.body.files }}` as { fileId, name, mimeType, size, url }.
 *  - The AI Chatbot can look at those pictures ("Pictures to look at").
 *  - The AI Picture step makes a new picture (Gemini), e.g. the customer's room with our furniture in it,
 *    keeps it like an upload and gives its link.
 */

export const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_PICTURES = 4;
const MAX_PICTURE_BYTES = 5 * 1024 * 1024;

type Ctx = NodeExecutionContext<any>;

/** File ids from whatever the field resolved to: a list of files, one file, an id, or a comma list of ids. */
export function pictureIds(value: unknown): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (v === null || v === undefined || v === '') return;
    if (Array.isArray(v)) return v.forEach(add);
    if (typeof v === 'object') {
      const id = (v as Record<string, unknown>).fileId;
      if (typeof id === 'string') out.push(id.trim());
      return;
    }
    const s = String(v).trim();
    if (s.startsWith('[') || s.startsWith('{')) {
      try {
        return add(JSON.parse(s));
      } catch {
        /* not JSON: treat as ids */
      }
    }
    s.split(/[\s,]+/).filter(Boolean).forEach((x) => out.push(x));
  };
  add(value);
  return [...new Set(out.filter((x) => /^file_[A-Za-z0-9_-]{10,100}$/.test(x)))];
}

/** Loads the pictures (JPG, PNG, WEBP) among the given files, for an AI request. PDFs and other files are skipped. */
export async function loadPictures(ctx: Ctx, value: unknown): Promise<{ images: AiImage[]; skipped: string[] }> {
  const ids = pictureIds(value);
  if (!ids.length) return { images: [], skipped: [] };
  const files = requireService(ctx.services, 'files', 'File storage');
  const images: AiImage[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    if (images.length >= MAX_PICTURES) {
      skipped.push(`${id} (more than ${MAX_PICTURES} pictures)`);
      continue;
    }
    const f = await files.load(id);
    if (!f) skipped.push(`${id} (not found or expired)`);
    else if (!PICTURE_TYPES.includes(f.mimeType)) skipped.push(`${f.name} (${f.mimeType} is not a picture)`);
    else if (f.data.byteLength > MAX_PICTURE_BYTES) skipped.push(`${f.name} (larger than 5 MB)`);
    else images.push({ mime: f.mimeType, data: Buffer.from(f.data).toString('base64') });
  }
  if (skipped.length) ctx.log(`Pictures skipped: ${skipped.join(', ')}`);
  return { images, skipped };
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/* ---------------------------------------------------------------- AI Picture */

export const aiPicture = defineNode({
  descriptor: {
    type: 'ai.image',
    version: 1,
    displayName: 'AI Picture',
    description: 'Make a picture with AI (Gemini), for example the customer’s room photo with your furniture in it.',
    category: 'ai',
    icon: 'image',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [{ id: 'main' }],
    credentialProvider: 'ai_provider',
    fields: [
      {
        key: 'prompt',
        label: 'What should the picture show?',
        type: 'text',
        required: true,
        expressions: true,
        default: 'Use the room in the photo. Keep its walls, windows, floor and the camera angle. Furnish it with: {{ $json.items }}. Photo-realistic, natural light.',
        help: 'Describe the picture in plain words. With a photo, say what to keep and what to add.',
      },
      {
        key: 'pictures',
        label: 'Pictures to start from (optional)',
        type: 'string',
        expressions: true,
        default: '',
        placeholder: '{{ $json.body.files }}',
        help: 'Photos the AI should work on, e.g. {{ $json.body.files }} from a Webhook upload. JPG, PNG or WEBP, up to 4.',
      },
      {
        key: 'ifFails',
        label: 'If no picture can be made',
        type: 'select',
        default: 'stop',
        options: [
          { label: 'Stop the run with an error', value: 'stop' },
          { label: 'Carry on without a picture', value: 'continue' },
        ],
        help: '“Carry on” keeps the run going (e.g. a chat still gets its text answer): the picture is empty and {{ $json.imageError }} says why.',
      },
      { key: 'saveAs', label: 'Save the picture as', type: 'string', default: 'image', help: 'Next steps use {{ $json.image.url }} (the link) and {{ $json.image.mimeType }}.' },
    ],
    inputSchema: { description: 'One picture is made per item.' },
    outputSchema: {
      description: 'The same item plus the picture: its link, type and file id.',
      example: [{ json: { image: { url: 'https://automation.widebed.com/api/files/file_abc…', mimeType: 'image/png', fileId: 'file_abc…' } } }],
    },
    retryable: false,
    available: true,
    docs: [
      '### AI Picture',
      'Makes one picture per item with a **Gemini** AI connection (model *gemini-2.5-flash-image*, unless the connection uses another image model).',
      '',
      '**Room preview for a website chat box**',
      '- *Webhook* receives the customer’s photo → **AI Picture**: Pictures `{{ $json.body.files }}`, prompt “Keep the room, add a grey 3-seater sofa and a wooden TV console…”',
      '- *Respond to Webhook*: field `image` = `{{ $json.image }}` — the chat box shows `image.url`.',
      '',
      'The picture is kept for 7 days and its link works without signing in, so only share it with the customer.',
      'Each picture is a paid AI request (about US$0.04 with Gemini). AI pictures are illustrations: colours and sizes can differ from the real products.',
    ].join('\n'),
  },
  configSchema: z.object({
    prompt: z.string({ required_error: 'Describe the picture' }).min(1, 'Describe the picture'),
    pictures: z.unknown().optional(),
    ifFails: z.enum(['stop', 'continue']).default('stop'),
    saveAs: z.string().regex(FIELD_NAME, 'Use letters, numbers and _ only (e.g. image)').default('image'),
  }),
  async execute(ctx) {
    if (!ctx.node.credentialId) throw new NodeError('Choose a Gemini AI connection for this node (Credentials → AI service)', { code: 'NO_CREDENTIAL' });
    const make = requireService(ctx.services, 'aiImage', 'AI pictures');
    const files = requireService(ctx.services, 'files', 'File storage');
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      if (ctx.signal.aborted) throw new NodeError('Execution cancelled', { code: 'CANCELLED' });
      const item = ctx.items[i]!;
      const c = ctx.resolve(ctx.config, item, i) as any;
      try {
        const prompt = String(c.prompt ?? '').trim().slice(0, 8000);
        if (!prompt) throw new NodeError('The description of the picture is empty. Check “What should the picture show?”.', { code: 'EMPTY_PROMPT' });
        const { images, skipped } = await loadPictures(ctx, c.pictures);
        if (!images.length && skipped.length)
          throw new NodeError(`The photos to start from could not be used: ${skipped.join(', ')}. Ask the customer to send the photo again.`, { code: 'PICTURES_MISSING' });
        const res = await make(ctx.node.credentialId, { prompt, images, signal: ctx.signal });
        const data = Buffer.from(res.data, 'base64');
        if (!data.length) throw new NodeError('The AI did not send a picture back. Try again, or describe the picture more clearly.', { code: 'AI_NO_IMAGE', retryable: true });
        const ref = await files.save(data, { name: `ai-picture.${EXT[res.mimeType] ?? 'png'}`, mimeType: res.mimeType });
        ctx.log(`Made a ${Math.round(data.length / 1024)} KB picture with ${res.model}`);
        out.push({ json: { ...item.json, [c.saveAs]: { url: ref.url, mimeType: ref.mimeType, fileId: ref.fileId, size: ref.size, note: res.text.slice(0, 500) } } });
      } catch (err) {
        if (c.ifFails !== 'continue' || ctx.signal.aborted) throw err;
        const why = err instanceof Error ? err.message : String(err);
        ctx.log(`No picture: ${why}`);
        out.push({ json: { ...item.json, [c.saveAs]: null, [`${c.saveAs}Error`]: why.slice(0, 500) } });
      }
    }
    return { outputs: { main: out } };
  },
});
