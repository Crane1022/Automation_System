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

/** File ids and https links from whatever the field resolved to: a list of files, one file, an id, a link, or a comma list. */
export function pictureRefs(value: unknown): { ids: string[]; urls: string[] } {
  const ids: string[] = [];
  const urls: string[] = [];
  const one = (x: string) => {
    x = x.trim();
    if (/^file_[A-Za-z0-9_-]{10,100}$/.test(x)) ids.push(x);
    else if (/^https:\/\/[^\s"'<>]{4,2000}$/i.test(x)) urls.push(x);
  };
  const add = (v: unknown) => {
    if (v === null || v === undefined || v === '') return;
    if (Array.isArray(v)) return v.forEach(add);
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.fileId === 'string') one(o.fileId);
      else if (typeof o.url === 'string') one(o.url);
      return;
    }
    const s = String(v).trim();
    if (s.startsWith('[') || s.startsWith('{')) {
      try {
        return add(JSON.parse(s));
      } catch {
        /* not JSON: treat as ids / links */
      }
    }
    s.split(/[\s,]+/).filter(Boolean).forEach(one);
  };
  add(value);
  return { ids: [...new Set(ids)], urls: [...new Set(urls)] };
}

/** File ids from whatever the field resolved to. */
export function pictureIds(value: unknown): string[] {
  return pictureRefs(value).ids;
}

/** The real picture type from the first bytes. */
function sniffPicture(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Width and height of a JPG, PNG or WEBP, or null. */
export function pictureSize(b: Buffer): { width: number; height: number } | null {
  const type = sniffPicture(b);
  if (type === 'image/png' && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (type === 'image/webp' && b.length >= 30) {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
  }
  if (type === 'image/jpeg') {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** Shapes Gemini can make. */
export const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
/** The supported shape closest to a picture's width / height. */
export function closestAspect(width: number, height: number): string {
  const r = width / height;
  let best = '1:1';
  let gap = Infinity;
  for (const a of ASPECT_RATIOS) {
    const [w, h] = a.split(':').map(Number) as [number, number];
    const d = Math.abs(Math.log(r / (w / h)));
    if (d < gap) { gap = d; best = a; }
  }
  return best;
}

/**
 * Loads the pictures (JPG, PNG, WEBP) among the given files and https links, for an AI request.
 * Kept files come first, then links (e.g. a product photo from a sheet). PDFs and other files are skipped.
 */
export async function loadPictures(ctx: Ctx, value: unknown, max = MAX_PICTURES): Promise<{ images: AiImage[]; skipped: string[]; sizes: ({ width: number; height: number } | null)[] }> {
  const { ids, urls } = pictureRefs(value);
  const images: AiImage[] = [];
  const sizes: ({ width: number; height: number } | null)[] = [];
  const skipped: string[] = [];
  const keep = (name: string, data: Buffer, declared: string) => {
    const mime = sniffPicture(data) ?? declared;
    if (!PICTURE_TYPES.includes(mime)) return skipped.push(`${name} (not a JPG, PNG or WEBP picture)`);
    if (data.byteLength > MAX_PICTURE_BYTES) return skipped.push(`${name} (larger than 5 MB)`);
    images.push({ mime, data: data.toString('base64') });
    sizes.push(pictureSize(data));
  };
  if (ids.length) {
    const files = requireService(ctx.services, 'files', 'File storage');
    for (const id of ids) {
      if (images.length >= max) { skipped.push(`${id} (more than ${max} pictures)`); continue; }
      const f = await files.load(id);
      if (!f) skipped.push(`${id} (not found or expired)`);
      else keep(f.name, Buffer.from(f.data), f.mimeType);
    }
  }
  for (const url of urls) {
    if (images.length >= max) { skipped.push(`${url} (more than ${max} pictures)`); continue; }
    try {
      const res = await ctx.services.http.request({ method: 'GET', url, responseType: 'base64', timeoutMs: 20_000, signal: ctx.signal, headers: { accept: 'image/jpeg,image/png,image/webp,image/*;q=0.8' } });
      if (res.status >= 400) { skipped.push(`${url} (HTTP ${res.status})`); continue; }
      keep(url, Buffer.from(res.body, 'base64'), String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase());
    } catch (err) {
      skipped.push(`${url} (${(err as Error).message})`);
    }
  }
  if (skipped.length) ctx.log(`Pictures skipped: ${skipped.join(', ')}`);
  return { images, skipped, sizes };
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
        help: 'Photos the AI should work on, e.g. {{ $json.body.files }} from a Webhook upload, or https links. JPG, PNG or WEBP.',
      },
      {
        key: 'references',
        label: 'Style pictures to copy (optional)',
        type: 'string',
        expressions: true,
        default: '',
        placeholder: '{{ $json.packageImage }}',
        help: 'Links (https) or files of the look to copy, e.g. the package photo from your sheet. They are sent after the pictures above. Say in the description what to take from them. Up to 4 pictures in all.',
      },
      {
        key: 'model',
        label: 'Picture model',
        type: 'string',
        default: '',
        placeholder: 'gemini-2.5-flash-image',
        help: 'Empty = gemini-2.5-flash-image (about US$0.04 a picture). gemini-3-pro-image-preview follows long instructions and reference pictures better and makes sharper pictures, at about US$0.13 a picture.',
      },
      {
        key: 'aspectRatio',
        label: 'Shape',
        type: 'select',
        default: 'auto',
        options: [{ label: 'Same as the first picture', value: 'auto' }, { label: 'Let the AI choose', value: '' }, ...ASPECT_RATIOS.map((a) => ({ label: a, value: a }))],
      },
      {
        key: 'imageSize',
        label: 'Size (Gemini 3 models only)',
        type: 'select',
        default: '2K',
        options: [{ label: '1K', value: '1K' }, { label: '2K', value: '2K' }, { label: '4K', value: '4K' }],
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
    references: z.unknown().optional(),
    model: z.string().regex(/^[A-Za-z0-9._-]*$/, 'Use a Gemini model name, e.g. gemini-2.5-flash-image').max(80).default(''),
    aspectRatio: z.string().refine((v) => v === '' || v === 'auto' || ASPECT_RATIOS.includes(v), 'Choose a shape').default('auto'),
    imageSize: z.enum(['1K', '2K', '4K']).default('2K'),
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
        const start = await loadPictures(ctx, c.pictures);
        if (!start.images.length && start.skipped.length)
          throw new NodeError(`The photos to start from could not be used: ${start.skipped.join(', ')}. Ask the customer to send the photo again.`, { code: 'PICTURES_MISSING' });
        const refs = await loadPictures(ctx, c.references, MAX_PICTURES - start.images.length);
        const images = [...start.images, ...refs.images];
        const first = start.sizes[0] ?? refs.sizes[0];
        const aspectRatio = c.aspectRatio === 'auto' ? (first ? closestAspect(first.width, first.height) : undefined) : c.aspectRatio || undefined;
        const res = await make(ctx.node.credentialId, { prompt, images, signal: ctx.signal, model: c.model || undefined, aspectRatio, imageSize: c.imageSize });
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
