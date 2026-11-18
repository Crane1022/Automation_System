/**
 * Small, safe Markdown → HTML for AI chat answers.
 * Everything is HTML-escaped first; only the formatting below is produced, so an
 * answer (or a web page the AI read) can never inject scripts or styles.
 *
 * Supports: headings, **bold**, *italic*, `code`, ``` code blocks ``` (with light
 * colouring), - / 1. lists, > quotes, tables, links (http/https/mailto only), ---.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const KEYWORDS = new Set(
  'const let var function return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof in of true false null undefined def elif lambda pass None True False select where and or not order by group limit insert update delete into values set'.split(' '),
);

/** Colours code with a few token types (keywords, strings, numbers, comments). */
export function highlight(code: string): string {
  const re = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
  let out = '';
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(code)); ) {
    out += esc(code.slice(last, m.index));
    const [tok, comment, str, num, word] = m;
    if (comment) out += `<span class="tok-c">${esc(tok)}</span>`;
    else if (str) out += `<span class="tok-s">${esc(tok)}</span>`;
    else if (num) out += `<span class="tok-n">${esc(tok)}</span>`;
    else if (word && KEYWORDS.has(word.toLowerCase())) out += `<span class="tok-k">${esc(tok)}</span>`;
    else out += esc(tok);
    last = m.index + tok.length;
  }
  return out + esc(code.slice(last));
}

function inline(s: string): string {
  // Pull out code spans first so nothing inside them is formatted.
  const codes: string[] = [];
  let t = s.replace(/`([^`\n]+)`/g, (_m, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = esc(t);
  t = t.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_m, label, href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  t = t.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (_m, pre, href) => `${pre}<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`);
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[Number(i)]!);
}

const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;

    // ``` code block (an unfinished one while streaming is shown as code too)
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      const lang = fence[1] ? `<span class="code-lang">${esc(fence[1])}</span>` : '';
      out.push(`<pre class="code-block">${lang}<button type="button" class="code-copy" data-copy>Copy</button><code>${highlight(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = Math.min(4, h[1]!.length + 2); // # → h3 … keeps headings modest inside a chat
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      i++;
      continue;
    }
    // Table: header row, then a --- separator row
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      flush();
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push(
        `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_c, k) => `<td>${inline(r[k] ?? '')}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    // Lists (one level; indented items stay in the same list)
    const li = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (m && /\d/.test(m[1]!) === ordered) {
          items.push(inline(m[2]!));
          i++;
        } else if (lines[i]!.trim() && /^\s{2,}\S/.test(lines[i]!) && items.length) {
          items[items.length - 1] += `<br>${inline(lines[i]!.trim())}`;
          i++;
        } else break;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${x}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return out.join('');
}
