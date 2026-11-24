/**
 * Small multipart/form-data reader for webhook calls (e.g. a website chat box that attaches photos).
 * Works on the raw bytes, so file contents stay exactly as sent.
 */

export interface MultipartFile {
  field: string;
  filename: string;
  mimeType: string;
  data: Buffer;
}
export interface MultipartBody {
  fields: Record<string, string>;
  files: MultipartFile[];
}

export function multipartBoundary(contentType: string | undefined): string | null {
  const ct = String(contentType ?? '');
  if (!/^\s*multipart\/form-data/i.test(ct)) return null;
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(ct);
  const b = m?.[1] ?? m?.[2] ?? '';
  return b && b.length <= 200 ? b : null;
}

const MAX_PARTS = 50;
const MAX_FIELD_BYTES = 256 * 1024;

/** Splits the body into text fields and files. Throws on a body that is not valid multipart. */
export function parseMultipart(raw: Buffer, boundary: string): MultipartBody {
  const out: MultipartBody = { fields: {}, files: [] };
  const delim = Buffer.from(`--${boundary}`);
  let pos = raw.indexOf(delim);
  if (pos < 0) throw new Error('The form data has no parts');
  let parts = 0;
  for (;;) {
    pos += delim.length;
    // "--" right after the boundary marks the end.
    if (raw[pos] === 0x2d && raw[pos + 1] === 0x2d) break;
    if (raw[pos] === 0x0d && raw[pos + 1] === 0x0a) pos += 2;
    const next = raw.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), pos);
    if (next < 0) throw new Error('The form data is cut off');
    const part = raw.subarray(pos, next);
    pos = next + 2;
    if (++parts > MAX_PARTS) throw new Error(`The form data has more than ${MAX_PARTS} parts`);

    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd < 0) continue;
    const head = part.subarray(0, headEnd).toString('utf8');
    const body = part.subarray(headEnd + 4);
    const disp = /^content-disposition:(.*)$/im.exec(head)?.[1] ?? '';
    const name = /\bname="([^"]*)"/i.exec(disp)?.[1];
    if (name === undefined) continue;
    const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1];
    if (filename !== undefined) {
      const type = /^content-type:\s*([^\r\n;]+)/im.exec(head)?.[1]?.trim().toLowerCase() ?? 'application/octet-stream';
      out.files.push({ field: name, filename: filename.replace(/[\\/]/g, '_').slice(0, 200) || 'file', mimeType: type, data: Buffer.from(body) });
    } else if (body.length <= MAX_FIELD_BYTES) {
      out.fields[name] = body.toString('utf8');
    } else {
      throw new Error(`The form field “${name}” is too long`);
    }
  }
  return out;
}

/** The real type of a file, from its first bytes. Only these types are kept. */
export function sniffFileType(data: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf' | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}
