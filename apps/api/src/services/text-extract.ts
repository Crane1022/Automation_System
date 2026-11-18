import zlib from 'node:zlib';

/**
 * Reads the TEXT out of an uploaded document, with no extra packages and no file storage:
 * only the text is kept (Firestore), the file itself is thrown away.
 *
 * Supported: .txt .md .csv .tsv .json .html/.htm, Word .docx, Excel .xlsx, and PDF
 * (best effort: PDFs made from text work; scanned PDFs are pictures and have no text).
 */
export class ExtractError extends Error {}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 500_000;

export interface Extracted {
  text: string;
  kind: 'text' | 'html' | 'docx' | 'xlsx' | 'pdf';
}

export function extractText(fileName: string, mime: string, data: Buffer): Extracted {
  if (data.length > MAX_UPLOAD_BYTES) throw new ExtractError('The file is larger than 10 MB. Split it, or paste the important part as text.');
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  let out: Extracted;
  if (ext === 'docx' || mime.includes('wordprocessingml')) out = { kind: 'docx', text: docx(data) };
  else if (ext === 'xlsx' || mime.includes('spreadsheetml')) out = { kind: 'xlsx', text: xlsx(data) };
  else if (ext === 'pdf' || mime === 'application/pdf') out = { kind: 'pdf', text: pdf(data) };
  else if (['html', 'htm'].includes(ext) || mime.includes('html')) out = { kind: 'html', text: htmlToText(decodeText(data)) };
  else if (['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'xml'].includes(ext) || mime.startsWith('text/') || mime.includes('json')) out = { kind: 'text', text: decodeText(data) };
  else if (['doc', 'xls', 'ppt'].includes(ext)) throw new ExtractError('Old Office files (.doc/.xls/.ppt) can’t be read. Open it and “Save as” .docx or .xlsx, then upload again.');
  else throw new ExtractError('This kind of file can’t be read. Use PDF, Word (.docx), Excel (.xlsx), or a text file.');
  const text = tidy(out.text);
  if (!text) {
    throw new ExtractError(
      out.kind === 'pdf' ? 'No text was found in this PDF. It is probably a scan (a picture of pages). Paste the text instead, or save it as Word.' : 'The file has no text in it.',
    );
  }
  return { kind: out.kind, text: text.slice(0, MAX_TEXT_CHARS) };
}

function decodeText(b: Buffer) {
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  return b.toString('utf8').replace(/^﻿/, '');
}

function tidy(s: string) {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function unescapeXml(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()] ?? m,
  );
}

export function htmlToText(html: string) {
  return unescapeXml(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|table|section|article)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<[^>]+>/g, ''),
  );
}

/* --------------------------------------------------------------- ZIP (Office) */

/** Reads the files inside a ZIP (Office documents are ZIPs). Only stored/deflated entries. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ExtractError('The file is damaged or not a real Office document.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, zlib.inflateRawSync(raw, { maxOutputLength: 50 * 1024 * 1024 }));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function docx(data: Buffer) {
  const files = unzip(data);
  const doc = files.get('word/document.xml');
  if (!doc) throw new ExtractError('This doesn’t look like a Word (.docx) document.');
  const xml = doc.toString('utf8');
  return unescapeXml(
    xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

function xlsx(data: Buffer) {
  const files = unzip(data);
  const shared: string[] = [];
  const ss = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  for (const si of ss.match(/<si>[\s\S]*?<\/si>/g) ?? []) shared.push(unescapeXml((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
  const wb = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const names = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => unescapeXml(m[1]!));
  const sheets = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  const out: string[] = [];
  sheets.forEach((k, i) => {
    const xml = files.get(k)!.toString('utf8');
    out.push(`## ${names[i] ?? `Sheet ${i + 1}`}`);
    for (const row of xml.match(/<row[\s\S]*?<\/row>/g) ?? []) {
      const cells = [...row.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
        const attrs = c[1] ?? '';
        const inner = c[2] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '';
        return / t="s"/.test(attrs) ? shared[Number(v)] ?? '' : unescapeXml(v);
      });
      if (cells.some((x) => x !== '')) out.push(cells.join('\t'));
    }
  });
  return out.join('\n');
}

/* ----------------------------------------------------------------------- PDF */

interface PdfObj {
  dict: string;
  stream: Buffer | null;
}

function ascii85(b: Buffer): Buffer {
  const s = b.toString('latin1').replace(/\s/g, '').replace(/^<~/, '').replace(/~>.*$/, '');
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of s) {
    if (ch === 'z' && !group.length) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Buffer.from(out);
}

/** Undoes the stream filters we understand; null if one is unknown (e.g. images). */
function decodeStream(dict: string, raw: Buffer): Buffer | null {
  const f = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] ?? '';
  const filters = [...f.matchAll(/\/(\w+)/g)].map((m) => m[1]!);
  let b = raw;
  for (const name of filters) {
    if (name === 'FlateDecode' || name === 'Fl') {
      try {
        b = zlib.inflateSync(b, { maxOutputLength: 20 * 1024 * 1024 });
      } catch {
        try {
          b = zlib.inflateSync(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: 20 * 1024 * 1024 });
        } catch {
          return null;
        }
      }
    } else if (name === 'ASCII85Decode' || name === 'A85') b = ascii85(b);
    else if (name === 'ASCIIHexDecode' || name === 'AHx') b = Buffer.from(b.toString('latin1').replace(/[^0-9a-f]/gi, ''), 'hex');
    else return null;
  }
  return b;
}

function pdfObjects(data: Buffer): Map<number, PdfObj> {
  const s = data.toString('latin1');
  const objs = new Map<number, PdfObj>();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  for (let m: RegExpExecArray | null; (m = re.exec(s)); ) {
    const id = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const endobj = s.indexOf('endobj', bodyStart);
    const streamAt = s.indexOf('stream', bodyStart);
    if (streamAt >= 0 && (endobj < 0 || streamAt < endobj) && s.slice(bodyStart, streamAt).includes('>>')) {
      const dict = s.slice(bodyStart, streamAt);
      let start = streamAt + 6;
      if (s[start] === '\r') start++;
      if (s[start] === '\n') start++;
      const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict)?.[1];
      let end = len ? start + Number(len) : s.indexOf('endstream', start);
      if (end > data.length || s.slice(end, end + 12).indexOf('endstream') < 0) end = s.indexOf('endstream', start);
      objs.set(id, { dict, stream: decodeStream(dict, data.subarray(start, end)) });
      re.lastIndex = s.indexOf('endobj', end) >= 0 ? s.indexOf('endobj', end) : end;
    } else {
      objs.set(id, { dict: s.slice(bodyStart, endobj < 0 ? undefined : endobj), stream: null });
      if (endobj >= 0) re.lastIndex = endobj;
    }
  }
  // Objects packed inside object streams (newer PDFs).
  for (const o of [...objs.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict) || !o.stream) continue;
    const n = Number(/\/N\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    const body = o.stream.toString('latin1');
    const head = body.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const id = head[i * 2]!;
      const off = first + head[i * 2 + 1]!;
      const next = i + 1 < n ? first + head[(i + 1) * 2 + 1]! : body.length;
      if (!objs.has(id)) objs.set(id, { dict: body.slice(off, next), stream: null });
    }
  }
  return objs;
}

const ref = (txt: string | undefined) => (txt ? Number(/^\s*(\d+)\s+\d+\s+R/.exec(txt)?.[1] ?? NaN) : NaN);

/** A font's way of turning character codes into text (from its ToUnicode map). */
interface FontMap {
  bytes: number;
  map: Map<number, string>;
}

function parseCMap(cmap: string): FontMap {
  const map = new Map<number, string>();
  const hexToStr = (h: string) => {
    let out = '';
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    if (h.length % 4 === 2) out += String.fromCharCode(parseInt(h.slice(-2), 16));
    return out;
  };
  let bytes = 1;
  const cs = /begincodespacerange\s*<([0-9a-f]+)>/i.exec(cmap);
  if (cs) bytes = cs[1]!.length / 2;
  for (const block of cmap.match(/beginbfchar([\s\S]*?)endbfchar/gi) ?? []) {
    for (const m of block.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) map.set(parseInt(m[1]!, 16), hexToStr(m[2]!));
  }
  for (const block of cmap.match(/beginbfrange([\s\S]*?)endbfrange/gi) ?? []) {
    for (const m of block.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<([0-9a-f]+)>|\[([^\]]*)\])/gi)) {
      const lo = parseInt(m[1]!, 16);
      const hi = parseInt(m[2]!, 16);
      if (hi - lo > 5000) continue;
      if (m[4] !== undefined) {
        const base = m[4]!;
        const last = parseInt(base.slice(-4) || base, 16);
        for (let c = lo; c <= hi; c++) map.set(c, hexToStr(base.slice(0, -4)) + String.fromCharCode(last + (c - lo)));
      } else {
        const list = [...(m[5] ?? '').matchAll(/<([0-9a-f]*)>/gi)].map((x) => hexToStr(x[1]!));
        list.forEach((v, i) => map.set(lo + i, v));
      }
    }
  }
  return { bytes, map };
}

/**
 * Best-effort PDF text, no packages: reads each page's content, its fonts and their
 * ToUnicode maps, then the text drawing commands. PDFs exported from Word, Google Docs,
 * LibreOffice or a browser work; scanned PDFs (pictures) have no text to read.
 */
function pdf(data: Buffer) {
  if (!data.subarray(0, 1024).toString('latin1').includes('%PDF')) throw new ExtractError('This file is not a real PDF.');
  const objs = pdfObjects(data);
  const dictOf = (txt: string | undefined): string => {
    if (!txt) return '';
    const r = ref(txt);
    return Number.isNaN(r) ? txt : objs.get(r)?.dict ?? '';
  };
  /** Finds "/Key value" where value is a dict << >> or a reference. */
  const entry = (dict: string, key: string): string | undefined => {
    const i = dict.search(new RegExp(`/${key}(?=[\\s<\\[/])`));
    if (i < 0) return undefined;
    let j = i + key.length + 1;
    while (/\s/.test(dict[j] ?? '')) j++;
    if (dict.startsWith('<<', j)) {
      let depth = 0;
      for (let k = j; k < dict.length - 1; k++) {
        if (dict.startsWith('<<', k)) {
          depth++;
          k++;
        } else if (dict.startsWith('>>', k)) {
          depth--;
          k++;
          if (!depth) return dict.slice(j, k + 1);
        }
      }
      return dict.slice(j);
    }
    if (dict[j] === '[') return dict.slice(j, dict.indexOf(']', j) + 1);
    return /^\s*(\d+\s+\d+\s+R|\/\w+|[\d.]+)/.exec(dict.slice(j))?.[1];
  };
  const fontCache = new Map<number, FontMap | null>();
  const fontMap = (id: number): FontMap | null => {
    if (fontCache.has(id)) return fontCache.get(id)!;
    const f = objs.get(id)?.dict ?? '';
    const tu = objs.get(ref(entry(f, 'ToUnicode')));
    const fm = tu?.stream ? parseCMap(tu.stream.toString('latin1')) : /\/Type0/.test(f) ? { bytes: 2, map: new Map() } : null;
    fontCache.set(id, fm);
    return fm;
  };

  const pages = [...objs.entries()].filter(([, o]) => /\/Type\s*\/Page(?!s)/.test(o.dict));
  const texts: string[] = [];
  for (const [, page] of pages) {
    // Resources may be on the page or inherited from its parents.
    let res = '';
    let node: string | undefined = page.dict;
    for (let hops = 0; node && hops < 10 && !res; hops++) {
      res = dictOf(entry(node, 'Resources'));
      if (!res) node = objs.get(ref(entry(node, 'Parent')))?.dict;
    }
    const fontsDict = dictOf(entry(res, 'Font'));
    const fonts = new Map<string, FontMap | null>();
    for (const m of fontsDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) fonts.set(m[1]!, fontMap(Number(m[2])));
    const contents = entry(page.dict, 'Contents') ?? '';
    const ids = [...contents.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
    const content = ids.map((id) => objs.get(id)?.stream?.toString('latin1') ?? '').join('\n');
    const t = pdfOps(content, fonts);
    if (t.trim()) texts.push(t);
  }
  // No page tree found (unusual files): read every stream with text commands.
  if (!texts.length) for (const o of objs.values()) if (o.stream) texts.push(pdfOps(o.stream.toString('latin1'), new Map()));
  const text = texts.join('\n\n');
  const letters = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (text.length > 50 && letters / text.length < 0.3) throw new ExtractError('This PDF uses a special font encoding, so its text can’t be read here. Open it, copy the text, and use “Type or paste” instead.');
  return text;
}

function literalBytes(raw: string): string {
  return raw.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_m, e: string) =>
    /^[0-7]+$/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' } as Record<string, string>)[e] ?? '',
  );
}

function decodeShown(bytes: string, font: FontMap | null | undefined): string {
  if (!font) return bytes; // simple fonts: Latin-1 / WinAnsi is close enough
  let out = '';
  for (let i = 0; i + font.bytes <= bytes.length; i += font.bytes) {
    let code = 0;
    for (let k = 0; k < font.bytes; k++) code = code * 256 + bytes.charCodeAt(i + k);
    out += font.map.get(code) ?? (font.bytes === 1 ? String.fromCharCode(code) : '');
  }
  return out;
}

function pdfOps(content: string, fonts: Map<string, FontMap | null>) {
  if (!/(Tj|TJ|')\b/.test(content) && !/T[jJ]/.test(content)) return '';
  const tok = /\((?:\\[\s\S]|[^\\()]|\((?:\\[\s\S]|[^\\()])*\))*\)|<[0-9A-Fa-f\s]*>|\/[^\s/[\]()<>{}]+|\[|\]|-?\d*\.?\d+|[A-Za-z'"*]+/g;
  let out = '';
  let font: FontMap | null | undefined = null;
  let size = 10;
  let lastShown = 0; // characters drawn since the last move
  const stack: string[] = [];
  let arr: string[] | null = null;
  const str = (t: string) => (t[0] === '(' ? literalBytes(t.slice(1, -1)) : Buffer.from(t.slice(1, -1).replace(/\s/g, '').padEnd(Math.ceil(t.slice(1, -1).replace(/\s/g, '').length / 2) * 2, '0'), 'hex').toString('latin1'));
  for (const m of content.matchAll(tok)) {
    const t = m[0];
    if (t === '[') arr = [];
    else if (t === ']') {
      if (arr) stack.push(`\u0001${arr.join('\u0002')}`);
      arr = null;
    } else if (arr) arr.push(t);
    else if (/^[A-Za-z'"*]+$/.test(t)) {
      const op = t;
      if (op === 'Tf') {
        font = fonts.get((stack[stack.length - 2] ?? '').slice(1));
        size = Math.abs(Number(stack[stack.length - 1])) || size;
      }
      else if (op === 'Tj' || op === "'" || op === '"') {
        if (op !== 'Tj') out += '\n';
        const s = stack[stack.length - 1];
        if (s && (s[0] === '(' || s[0] === '<')) {
          const piece = decodeShown(str(s), font);
          out += piece;
          lastShown += piece.length;
        }
      } else if (op === 'TJ') {
        const s = stack[stack.length - 1] ?? '';
        if (s[0] === '\u0001') {
          for (const piece of s.slice(1).split('\u0002')) {
            if (piece[0] === '(' || piece[0] === '<') {
              const txt = decodeShown(str(piece), font);
              out += txt;
              lastShown += txt.length;
            }
            else if (Number(piece) < -180) out += ' ';
          }
        }
      } else if (op === 'Td' || op === 'TD') {
        const dy = Number(stack[stack.length - 1]);
        const dx = Number(stack[stack.length - 2]);
        // Same line: only a gap wider than the text just drawn means a space.
        if (dy) out += '\n';
        else if (!lastShown || dx > Math.max(lastShown * size * 0.62, size * 1.05) + size * 0.12) out += ' ';
        lastShown = 0;
      } else if (op === 'T*' || op === 'ET') out += '\n';
      else if (op === 'Tm') out += '\n';
      if (op === 'Td' || op === 'TD' || op === 'T*' || op === 'ET' || op === 'Tm') lastShown = 0;
      stack.length = 0;
    } else stack.push(t);
  }
  return out
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    .map(unspace)
    .join('\n');
}

/** "H o u s e  r u l e s" (one letter per draw command) → "House rules". */
function unspace(line: string) {
  const parts = line.split(' ');
  if (parts.length < 6) return line;
  const single = parts.filter((p) => p.length === 1).length;
  if (single / parts.length < 0.7) return line;
  return line.replace(/ {2,}/g, '\u0000').replace(/ /g, '').replace(/\u0000/g, ' ');
}

/* -------------------------------------------------------------- chunking */

/** Splits text into pieces of about `size` characters, on paragraph or sentence breaks, with headings kept. */
export function chunkText(text: string, size = 1500): string[] {
  const paras = text.split(/\n{2,}|\n(?=#|\d+\.\s|- )/);
  const out: string[] = [];
  let cur = '';
  let heading = '';
  for (const raw of paras) {
    const p = raw.trim();
    if (!p) continue;
    if (/^#{1,6}\s/.test(p) && p.length < 120) heading = p.replace(/^#+\s*/, '');
    if ((cur + '\n\n' + p).length > size && cur) {
      out.push(cur);
      cur = heading && !p.startsWith('#') ? `(${heading})\n${p}` : p;
    } else cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > size * 1.5) {
      const cut = Math.max(cur.lastIndexOf('. ', size), cur.lastIndexOf('\n', size), size * 0.6);
      out.push(cur.slice(0, cut + 1).trim());
      cur = cur.slice(cut + 1).trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}
