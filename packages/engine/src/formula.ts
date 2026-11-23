import { todayInfo } from '@widebed/shared';

/**
 * Formulas inside {{ }} — n8n-style, but safe.
 *
 *   {{ $json.name.toUpperCase() }}
 *   {{ $('Webhook').item.json.body.full_name.split(' ')[0] }}
 *   {{ $now.format('yyyy-MM-dd') }}   {{ $now.plus(3, 'days').toFormat('d MMM') }}
 *   {{ $json.total > 100 ? 'big' : 'small' }}
 *   {{ $json.rooms.map(r => r.name).join(', ') }}
 *
 * This is NOT JavaScript `eval`. Formulas are parsed and interpreted here, with:
 *  - no assignments, loops, `new`, `this`, globals, imports, network or files;
 *  - property access to own data only (never __proto__ / constructor / prototype);
 *  - method calls only from an allow-list per value type (string, number, array, date…);
 *  - a step budget and size caps, so a formula cannot hang the worker or eat memory.
 */

export class FormulaError extends Error {}

/* ================================================================ scope */

export interface FormulaScope {
  item?: { json: Record<string, unknown> };
  itemIndex?: number;
  /** First output item json of each executed node, by id and by name. */
  nodes: Record<string, Record<string, unknown> | undefined>;
  /** All output items (json) of an executed node, by id or name. */
  allItems?: (node: string) => Record<string, unknown>[] | undefined;
  trigger?: Record<string, unknown>;
  executionId: string;
  workflowId: string;
  now?: () => string;
  timezone?: string;
}

/* ================================================================ tokens */

type Tok =
  | { t: 'num'; v: number; p: number }
  | { t: 'str'; v: string; p: number }
  | { t: 'tpl'; parts: (string | string)[]; exprs: string[]; p: number }
  | { t: 'id'; v: string; p: number }
  | { t: 'op'; v: string; p: number }
  | { t: 'eof'; p: number };

const OPS = ['===', '!==', '?.', '??', '=>', '==', '!=', '<=', '>=', '&&', '||', '...', '.', '[', ']', '(', ')', '{', '}', ',', '?', ':', '!', '+', '-', '*', '/', '%', '<', '>'];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:0[xX][0-9a-fA-F]+|\d*\.?\d+(?:[eE][+-]?\d+)?)/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]), p: i });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          const n = src[j + 1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n ?? '';
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new FormulaError(`A text in quotes is not closed (starting at ${i + 1})`);
      out.push({ t: 'str', v: s, p: i });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      // Template literal: `Hi ${name}` — parts and the source of each ${…}
      let j = i + 1;
      const parts: string[] = [];
      const exprs: string[] = [];
      let cur = '';
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') {
          cur += src[j + 1] ?? '';
          j += 2;
        } else if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 1;
          let k = j + 2;
          while (k < src.length && depth) {
            if (src[k] === '{') depth++;
            else if (src[k] === '}') depth--;
            k++;
          }
          if (depth) throw new FormulaError('A ${…} inside `…` is not closed');
          parts.push(cur);
          cur = '';
          exprs.push(src.slice(j + 2, k - 1));
          j = k;
        } else cur += src[j++];
      }
      if (j >= src.length) throw new FormulaError('A text in `…` is not closed');
      parts.push(cur);
      out.push({ t: 'tpl', parts, exprs, p: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0], p: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaError(`Unexpected “${c}” at position ${i + 1}`);
    // "?." followed by a digit is "? .5" (ternary), not optional chaining
    if (op === '?.' && /[0-9]/.test(src[i + 2] ?? '')) {
      out.push({ t: 'op', v: '?', p: i });
      i += 1;
      continue;
    }
    out.push({ t: 'op', v: op, p: i });
    i += op.length;
  }
  out.push({ t: 'eof', p: src.length });
  return out;
}

/* ================================================================ AST */

type Node =
  | { k: 'lit'; v: unknown }
  | { k: 'tpl'; parts: string[]; exprs: Node[] }
  | { k: 'id'; name: string }
  | { k: 'mem'; obj: Node; prop: Node; computed: boolean; opt: boolean }
  | { k: 'call'; callee: Node; args: Node[]; opt: boolean }
  | { k: 'un'; op: string; arg: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'cond'; test: Node; yes: Node; no: Node }
  | { k: 'arr'; items: Node[] }
  | { k: 'obj'; props: { key: string; value: Node }[] }
  | { k: 'arrow'; params: string[]; body: Node };

const BIN: Record<string, number> = { '??': 1, '||': 1, '&&': 2, '==': 3, '!=': 3, '===': 3, '!==': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
const MAX_DEPTH = 80;

class Parser {
  i = 0;
  depth = 0;
  constructor(private toks: Tok[], private src: string) {}
  peek(o = 0) {
    return this.toks[this.i + o]!;
  }
  isOp(v: string, o = 0) {
    const t = this.peek(o);
    return t.t === 'op' && t.v === v;
  }
  eat(v: string) {
    if (!this.isOp(v)) throw new FormulaError(`Expected “${v}” at position ${this.peek().p + 1} in “${this.src}”`);
    this.i++;
  }
  parse(): Node {
    const n = this.expr();
    if (this.peek().t !== 'eof') throw new FormulaError(`Unexpected “${this.src.slice(this.peek().p, this.peek().p + 12)}” in “${this.src}”`);
    return n;
  }
  expr(): Node {
    if (++this.depth > MAX_DEPTH) throw new FormulaError('The formula is nested too deeply');
    try {
      return this.cond();
    } finally {
      this.depth--;
    }
  }
  cond(): Node {
    // arrow function: x => …  or (a, b) => …
    const t = this.peek();
    if (t.t === 'id' && this.isOp('=>', 1)) {
      this.i += 2;
      return { k: 'arrow', params: [t.v], body: this.expr() };
    }
    if (this.isOp('(')) {
      let j = 1;
      const params: string[] = [];
      let ok = true;
      while (!this.isOp(')', j)) {
        const p = this.peek(j);
        if (p.t !== 'id') {
          ok = false;
          break;
        }
        params.push(p.v);
        j++;
        if (this.isOp(',', j)) j++;
        else if (!this.isOp(')', j)) {
          ok = false;
          break;
        }
      }
      if (ok && this.isOp('=>', j + 1)) {
        this.i += j + 2;
        return { k: 'arrow', params, body: this.expr() };
      }
    }
    const test = this.binary(1);
    if (this.isOp('?')) {
      this.i++;
      const yes = this.expr();
      this.eat(':');
      const no = this.expr();
      return { k: 'cond', test, yes, no };
    }
    return test;
  }
  binary(min: number): Node {
    let l = this.unary();
    for (;;) {
      const t = this.peek();
      const prec = t.t === 'op' ? BIN[t.v] : undefined;
      if (prec === undefined || prec < min) return l;
      this.i++;
      const r = this.binary(prec + 1);
      l = { k: 'bin', op: (t as { v: string }).v, l, r };
    }
  }
  unary(): Node {
    if (this.isOp('!') || this.isOp('-') || this.isOp('+')) {
      const op = (this.peek() as { v: string }).v;
      this.i++;
      return { k: 'un', op, arg: this.unary() };
    }
    const t = this.peek();
    if (t.t === 'id' && t.v === 'typeof') {
      this.i++;
      return { k: 'un', op: 'typeof', arg: this.unary() };
    }
    return this.postfix(this.primary());
  }
  postfix(n: Node): Node {
    for (;;) {
      if (this.isOp('.') || this.isOp('?.')) {
        const opt = this.isOp('?.');
        this.i++;
        if (opt && this.isOp('(')) {
          n = { k: 'call', callee: n, args: this.args(), opt: true };
          continue;
        }
        if (opt && this.isOp('[')) {
          this.i++;
          const prop = this.expr();
          this.eat(']');
          n = { k: 'mem', obj: n, prop, computed: true, opt: true };
          continue;
        }
        const t = this.peek();
        if (t.t !== 'id') throw new FormulaError(`Expected a name after “.” at position ${t.p + 1}`);
        this.i++;
        n = { k: 'mem', obj: n, prop: { k: 'lit', v: t.v }, computed: false, opt };
      } else if (this.isOp('[')) {
        this.i++;
        const prop = this.expr();
        this.eat(']');
        n = { k: 'mem', obj: n, prop, computed: true, opt: false };
      } else if (this.isOp('(')) {
        n = { k: 'call', callee: n, args: this.args(), opt: false };
      } else return n;
    }
  }
  args(): Node[] {
    this.eat('(');
    const out: Node[] = [];
    while (!this.isOp(')')) {
      out.push(this.expr());
      if (!this.isOp(')')) this.eat(',');
    }
    this.eat(')');
    return out;
  }
  primary(): Node {
    const t = this.peek();
    this.i++;
    if (t.t === 'num' || t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'tpl') return { k: 'tpl', parts: t.parts as string[], exprs: t.exprs.map((e) => parseFormula(e)) };
    if (t.t === 'id') {
      if (t.v === 'true') return { k: 'lit', v: true };
      if (t.v === 'false') return { k: 'lit', v: false };
      if (t.v === 'null') return { k: 'lit', v: null };
      if (t.v === 'undefined') return { k: 'lit', v: undefined };
      if (['new', 'this', 'function', 'class', 'import', 'await', 'yield', 'delete', 'void', 'eval', 'require', 'globalThis', 'window', 'process'].includes(t.v)) {
        throw new FormulaError(`“${t.v}” is not allowed in formulas`);
      }
      return { k: 'id', name: t.v };
    }
    if (t.t === 'op' && t.v === '(') {
      const n = this.expr();
      this.eat(')');
      return n;
    }
    if (t.t === 'op' && t.v === '[') {
      const items: Node[] = [];
      while (!this.isOp(']')) {
        items.push(this.expr());
        if (!this.isOp(']')) this.eat(',');
      }
      this.eat(']');
      return { k: 'arr', items };
    }
    if (t.t === 'op' && t.v === '{') {
      const props: { key: string; value: Node }[] = [];
      while (!this.isOp('}')) {
        const k = this.peek();
        this.i++;
        if (k.t !== 'id' && k.t !== 'str' && k.t !== 'num') throw new FormulaError('Object keys must be names or texts');
        const key = String(k.v);
        if (FORBIDDEN.has(key)) throw new FormulaError(`“${key}” is not allowed`);
        if (this.isOp(':')) {
          this.i++;
          props.push({ key, value: this.expr() });
        } else if (k.t === 'id') props.push({ key, value: { k: 'id', name: key } });
        else throw new FormulaError('Expected “:” in object');
        if (!this.isOp('}')) this.eat(',');
      }
      this.eat('}');
      return { k: 'obj', props };
    }
    throw new FormulaError(`Unexpected “${this.src.slice(t.p, t.p + 12) || 'end'}” in “${this.src}”`);
  }
}

const cache = new Map<string, Node>();
/** Parses (and caches) a formula. Throws FormulaError with a readable message. */
export function parseFormula(src: string): Node {
  const hit = cache.get(src);
  if (hit) return hit;
  if (src.length > 10_000) throw new FormulaError('The formula is too long (max 10 000 characters)');
  const node = new Parser(tokenize(src), src).parse();
  if (cache.size > 2000) cache.clear();
  cache.set(src, node);
  return node;
}

/* ================================================================ values */

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
const MAX_STR = 1_000_000;
const MAX_ARR = 100_000;

class Closure {
  constructor(public params: string[], public body: Node, public env: Env) {}
}
/** A built-in function such as Math.round or JSON.stringify. */
class Builtin {
  constructor(public name: string, public fn: (...a: unknown[]) => unknown) {}
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const UNIT_MS: Record<string, number> = { millisecond: 1, second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
const unitName = (u: unknown) => String(u ?? 'days').toLowerCase().replace(/s$/, '');

/** A moment in time shown in a time zone (Malaysia by default). Like n8n's / Luxon's DateTime. */
export class FDate {
  constructor(public ms: number, public zone: string) {}
  parts() {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: this.zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'long' });
    const p = Object.fromEntries(f.formatToParts(new Date(this.ms)).map((x) => [x.type, x.value]));
    return { year: +p.year!, month: +p.month!, day: +p.day!, hour: +p.hour!, minute: +p.minute!, second: +p.second!, weekday: p.weekday as string };
  }
  format(fmt: unknown = 'yyyy-MM-dd') {
    const p = this.parts();
    const pad = (n: number, l = 2) => String(n).padStart(l, '0');
    return String(fmt).replace(/'([^']*)'|yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|hh|h|mm|m|ss|s|a/g, (tok, lit) => {
      if (lit !== undefined) return lit;
      switch (tok) {
        case 'yyyy': return String(p.year);
        case 'yy': return pad(p.year % 100);
        case 'MMMM': return MONTHS[p.month - 1]!;
        case 'MMM': return MONTHS[p.month - 1]!.slice(0, 3);
        case 'MM': return pad(p.month);
        case 'M': return String(p.month);
        case 'dd': return pad(p.day);
        case 'd': return String(p.day);
        case 'EEEE': return p.weekday;
        case 'EEE': return p.weekday.slice(0, 3);
        case 'HH': return pad(p.hour);
        case 'H': return String(p.hour);
        case 'hh': return pad(p.hour % 12 || 12);
        case 'h': return String(p.hour % 12 || 12);
        case 'mm': return pad(p.minute);
        case 'm': return String(p.minute);
        case 'ss': return pad(p.second);
        case 's': return String(p.second);
        case 'a': return p.hour < 12 ? 'AM' : 'PM';
        default: return tok;
      }
    });
  }
  plus(n: unknown, unit?: unknown): FDate {
    if (n && typeof n === 'object') {
      let d: FDate = this;
      for (const [u, v] of Object.entries(n as Record<string, unknown>)) d = d.plus(v, u);
      return d;
    }
    const u = unitName(unit);
    const amount = Number(n) || 0;
    if (u === 'month' || u === 'year') {
      const p = this.parts();
      const months = u === 'year' ? amount * 12 : amount;
      const total = p.year * 12 + (p.month - 1) + months;
      const y = Math.floor(total / 12);
      const m = total - y * 12;
      const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const shift = Date.UTC(y, m, Math.min(p.day, lastDay)) - Date.UTC(p.year, p.month - 1, p.day);
      return new FDate(this.ms + shift, this.zone);
    }
    const size = UNIT_MS[u];
    if (!size) throw new FormulaError(`Unknown time unit “${String(unit)}” (use minutes, hours, days, weeks, months or years)`);
    return new FDate(this.ms + amount * size, this.zone);
  }
  minus(n: unknown, unit?: unknown): FDate {
    if (n && typeof n === 'object') return this.plus(Object.fromEntries(Object.entries(n as Record<string, unknown>).map(([k, v]) => [k, -(Number(v) || 0)])));
    return this.plus(-(Number(n) || 0), unit);
  }
  startOf(unit: unknown): FDate {
    const p = this.parts();
    const u = unitName(unit);
    const back = u === 'day' ? (p.hour * 3600 + p.minute * 60 + p.second) * 1000 + (this.ms % 1000)
      : u === 'hour' ? (p.minute * 60 + p.second) * 1000 + (this.ms % 1000)
      : u === 'month' ? ((p.day - 1) * 86400 + p.hour * 3600 + p.minute * 60 + p.second) * 1000 + (this.ms % 1000)
      : 0;
    return new FDate(this.ms - back, this.zone);
  }
  toISO() {
    return new Date(this.ms).toISOString();
  }
  toString() {
    return this.toISO();
  }
  valueOf() {
    return this.ms;
  }
}

/** Reads a date from text (2026-12-01, 01/12/2026, ISO), a number (ms) or a date. */
function toFDate(v: unknown, zone: string): FDate {
  if (v instanceof FDate) return v;
  if (typeof v === 'number') return new FDate(v, zone);
  const s = String(v ?? '').trim();
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (dmy) return dayStart(+dmy[3]!, +dmy[2]!, +dmy[1]!, zone);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (ymd) return dayStart(+ymd[1]!, +ymd[2]!, +ymd[3]!, zone);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new FormulaError(`“${s.slice(0, 40)}” is not a date`);
  return new FDate(ms, zone);
}
/** Midnight of a calendar day in a time zone. */
function dayStart(y: number, m: number, d: number, zone: string): FDate {
  const guess = Date.UTC(y, m - 1, d);
  const p = new FDate(guess, zone).parts();
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - guess;
  return new FDate(guess - offset, zone);
}

/** $today: the date text (2026-11-14), plus .tomorrow/.weekday… and the date methods. */
class Today {
  constructor(public info: ReturnType<typeof todayInfo>, public date: FDate) {}
  toString() {
    return this.info.date;
  }
  valueOf() {
    return this.info.date;
  }
}

/** $('Node') */
class NodeRef {
  constructor(public first: Record<string, unknown> | undefined, public all: () => Record<string, unknown>[]) {}
}
/** $node["X"] — the first item, readable as .json.a or .a */
class NodeJson {
  constructor(public data: Record<string, unknown> | undefined) {}
}

type Env = { vars: Map<string, unknown>; parent?: Env };
const NODE_ROOT = Object.freeze({});

/* ================================================================ interpreter */

export function evaluateFormula(src: string, scope: FormulaScope): unknown {
  const ast = parseFormula(src);
  const zone = scope.timezone || 'Asia/Kuala_Lumpur';
  const nowMs = scope.now ? Date.parse(scope.now()) : Date.now();
  let budget = 200_000;
  const tick = () => {
    if (--budget < 0) throw new FormulaError('The formula takes too long (too many steps)');
  };
  const json = scope.item?.json ?? {};
  const allOf = (name: string) => scope.allItems?.(name) ?? (scope.nodes[name] ? [scope.nodes[name]!] : []);

  const globals: Record<string, unknown> = {
    $json: json,
    $itemIndex: scope.itemIndex ?? 0,
    $runIndex: 0,
    $execution: { id: scope.executionId, mode: 'production' },
    $workflow: { id: scope.workflowId },
    $trigger: scope.trigger ?? {},
    $node: NODE_ROOT, // $node["Step"] — handled in member access
    $input: { item: { json }, first: new Builtin('first', () => ({ json })), last: new Builtin('last', () => ({ json })), all: new Builtin('all', () => [{ json }]) },
    $: new Builtin('$', (name) => {
      const n = String(name);
      if (!(n in scope.nodes)) throw new FormulaError(`There is no step called “${n}” before this one (or it has not run yet)`);
      return new NodeRef(scope.nodes[n], () => allOf(n));
    }),
    Math: { ...Object.fromEntries(['abs', 'ceil', 'floor', 'round', 'max', 'min', 'pow', 'sqrt', 'trunc', 'sign', 'random'].map((f) => [f, new Builtin(`Math.${f}`, (Math as any)[f])])), PI: Math.PI },
    JSON: { stringify: new Builtin('JSON.stringify', (v, _r, sp) => JSON.stringify(plain(v), null, sp as number)), parse: new Builtin('JSON.parse', (s) => JSON.parse(String(s))) },
    Object: { keys: new Builtin('Object.keys', (o) => Object.keys(own(o))), values: new Builtin('Object.values', (o) => Object.values(own(o))), entries: new Builtin('Object.entries', (o) => Object.entries(own(o))) },
    Array: { isArray: new Builtin('Array.isArray', (v) => Array.isArray(v)) },
    Number: new Builtin('Number', (v) => Number(v)),
    String: new Builtin('String', (v) => str(v)),
    Boolean: new Builtin('Boolean', (v) => Boolean(v)),
    parseInt: new Builtin('parseInt', (v, r) => parseInt(String(v), (r as number) || 10)),
    parseFloat: new Builtin('parseFloat', (v) => parseFloat(String(v))),
    isNaN: new Builtin('isNaN', (v) => Number.isNaN(Number(v))),
    encodeURIComponent: new Builtin('encodeURIComponent', (v) => encodeURIComponent(String(v))),
    DateTime: { now: new Builtin('DateTime.now', () => new FDate(nowMs, zone)), fromISO: new Builtin('DateTime.fromISO', (v) => toFDate(v, zone)) },
  };

  function own(o: unknown): Record<string, unknown> {
    if (o instanceof NodeJson) return o.data ?? {};
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
  }
  function plain(v: unknown): unknown {
    if (v instanceof FDate) return v.toISO();
    if (v instanceof Today) return v.info.date;
    if (v instanceof NodeJson) return v.data;
    if (v instanceof Closure || v instanceof Builtin) return undefined;
    return v;
  }
  function str(v: unknown): string {
    v = plain(v);
    if (v === null || v === undefined) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  const capStr = (s: string) => {
    if (s.length > MAX_STR) throw new FormulaError('The text made by the formula is too long');
    return s;
  };

  // Dates are only worked out when a formula uses them (keeps simple formulas fast).
  const lazy: Record<string, () => unknown> = {
    $now: () => new FDate(nowMs, zone),
    $today: () => {
      const info = todayInfo(new Date(nowMs), zone);
      const [y, m, d] = info.date.split('-').map(Number) as [number, number, number];
      return new Today(info, dayStart(y, m, d, zone));
    },
  };
  function lookup(name: string, env: Env | undefined): unknown {
    for (let e = env; e; e = e.parent) if (e.vars.has(name)) return e.vars.get(name);
    if (lazy[name]) {
      globals[name] = lazy[name]!();
      delete lazy[name];
    }
    if (Object.prototype.hasOwnProperty.call(globals, name)) return globals[name];
    throw new FormulaError(`Unknown variable “${name}”. Use $json, $('Step name'), $node, $trigger, $now, $today, $execution, $workflow or $itemIndex.`);
  }

  function member(obj: unknown, key: unknown): unknown {
    tick();
    if (obj === null || obj === undefined) return undefined;
    if (typeof key === 'string' && FORBIDDEN.has(key)) return undefined;
    if (obj === NODE_ROOT) return new NodeJson(scope.nodes[String(key)]);
    if (obj instanceof NodeJson) return key === 'json' ? obj.data ?? {} : obj.data?.[String(key)];
    if (obj instanceof NodeRef) {
      if (key === 'item') return { json: obj.first ?? {} };
      if (key === 'json') return obj.first ?? {};
      if (key === 'isExecuted') return obj.first !== undefined;
      return undefined; // first()/last()/all() are calls
    }
    if (obj instanceof Today) {
      const k = String(key);
      if (Object.prototype.hasOwnProperty.call(obj.info, k)) return (obj.info as Record<string, unknown>)[k];
      return member(obj.date, key);
    }
    if (obj instanceof FDate) {
      const p = obj.parts();
      const map: Record<string, unknown> = { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second, weekday: p.weekday, weekdayLong: p.weekday, weekdayShort: p.weekday.slice(0, 3), monthLong: MONTHS[p.month - 1], monthShort: MONTHS[p.month - 1]!.slice(0, 3), zoneName: obj.zone };
      return map[String(key)];
    }
    if (typeof obj === 'string') {
      if (key === 'length') return obj.length;
      if (typeof key === 'number' || /^\d+$/.test(String(key))) return obj[Number(key)];
      return undefined;
    }
    if (Array.isArray(obj)) {
      if (key === 'length') return obj.length;
      if (typeof key === 'number' || /^-?\d+$/.test(String(key))) return obj[Number(key)];
      return undefined;
    }
    if (typeof obj === 'object' && !(obj instanceof Closure) && !(obj instanceof Builtin)) {
      const k = String(key);
      return Object.prototype.hasOwnProperty.call(obj, k) ? (obj as Record<string, unknown>)[k] : undefined;
    }
    return undefined;
  }

  function callFn(fn: unknown, args: unknown[]): unknown {
    tick();
    if (fn instanceof Builtin) return fn.fn(...args);
    if (fn instanceof Closure) {
      const vars = new Map<string, unknown>();
      fn.params.forEach((p, i) => vars.set(p, args[i]));
      return ev(fn.body, { vars, parent: fn.env });
    }
    throw new FormulaError('This is not something you can call');
  }

  function method(obj: unknown, name: string, args: unknown[]): unknown {
    tick();
    const fnArg = (i: number) => {
      const f = args[i];
      if (!(f instanceof Closure) && !(f instanceof Builtin)) throw new FormulaError(`.${name}() needs a function, e.g. x => x.name`);
      return (...a: unknown[]) => callFn(f, a);
    };
    if (obj instanceof NodeRef) {
      const all = obj.all();
      if (name === 'first') return { json: all[0] ?? obj.first ?? {} };
      if (name === 'last') return { json: all[all.length - 1] ?? {} };
      if (name === 'all') return all.map((j) => ({ json: j }));
      if (name === 'itemMatching') return { json: all[Number(args[0]) || 0] ?? {} };
    }
    if (obj instanceof Today) obj = obj.date;
    if (obj instanceof FDate) {
      switch (name) {
        case 'format': case 'toFormat': return obj.format(args[0]);
        case 'toISO': case 'toString': case 'toJSON': return obj.toISO();
        case 'toISODate': return obj.format('yyyy-MM-dd');
        case 'toMillis': case 'valueOf': return obj.ms;
        case 'toSeconds': return Math.floor(obj.ms / 1000);
        case 'plus': return obj.plus(args[0], args[1]);
        case 'minus': return obj.minus(args[0], args[1]);
        case 'startOf': return obj.startOf(args[0]);
        case 'setZone': return new FDate(obj.ms, String(args[0] || obj.zone));
        case 'diff': case 'diffTo': {
          const other = toFDate(args[0], obj.zone);
          const u = unitName(args[1]);
          return (obj.ms - other.ms) / (UNIT_MS[u] ?? UNIT_MS.day!);
        }
        case 'isBefore': return obj.ms < toFDate(args[0], obj.zone).ms;
        case 'isAfter': return obj.ms > toFDate(args[0], obj.zone).ms;
      }
      throw new FormulaError(`Dates have no .${name}(). Try format('yyyy-MM-dd'), plus(1, 'days'), minus(), startOf('day'), toISO()`);
    }
    if (typeof obj === 'string') {
      const s = obj;
      switch (name) {
        case 'toUpperCase': return s.toUpperCase();
        case 'toLowerCase': return s.toLowerCase();
        case 'trim': return s.trim();
        case 'trimStart': return s.trimStart();
        case 'trimEnd': return s.trimEnd();
        case 'split': return s.split(str(args[0] ?? ''), args[1] === undefined ? undefined : Number(args[1])).slice(0, MAX_ARR);
        case 'replace': return capStr(s.replace(str(args[0]), () => str(args[1])));
        case 'replaceAll': return capStr(s.split(str(args[0])).join(str(args[1])));
        case 'includes': return s.includes(str(args[0]));
        case 'startsWith': return s.startsWith(str(args[0]));
        case 'endsWith': return s.endsWith(str(args[0]));
        case 'indexOf': return s.indexOf(str(args[0]));
        case 'lastIndexOf': return s.lastIndexOf(str(args[0]));
        case 'slice': return s.slice(args[0] as number, args[1] as number);
        case 'substring': return s.substring(args[0] as number, args[1] as number);
        case 'substr': return s.substr(args[0] as number, args[1] as number);
        case 'charAt': return s.charAt(Number(args[0]) || 0);
        case 'at': return s.at(Number(args[0]) || 0);
        case 'padStart': return capStr(s.padStart(Math.min(Number(args[0]) || 0, MAX_STR), str(args[1] ?? ' ')));
        case 'padEnd': return capStr(s.padEnd(Math.min(Number(args[0]) || 0, MAX_STR), str(args[1] ?? ' ')));
        case 'repeat': { const n = Math.max(0, Math.floor(Number(args[0]) || 0)); if (n * s.length > MAX_STR) throw new FormulaError('The text made by the formula is too long'); return s.repeat(n); }
        case 'concat': return capStr(s + args.map(str).join(''));
        case 'toString': return s;
        case 'localeCompare': return s.localeCompare(str(args[0]));
        case 'normalize': return s.normalize();
        // n8n helpers
        case 'isEmpty': return s.trim() === '';
        case 'isNotEmpty': return s.trim() !== '';
        case 'toNumber': return Number(s.replace(/[^0-9.+-eE]/g, ''));
        case 'toTitleCase': return s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
        case 'toSentenceCase': return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
        case 'toDateTime': case 'toDate': return toFDate(s, zone);
        case 'extractEmail': return /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(s)?.[0] ?? '';
        case 'removeTags': return s.replace(/<[^>]*>/g, '');
        case 'urlEncode': return encodeURIComponent(s);
      }
      throw new FormulaError(`Texts have no .${name}(). Try toUpperCase(), trim(), split(' '), replace('a', 'b'), includes('x'), slice(0, 5)`);
    }
    if (typeof obj === 'number') {
      switch (name) {
        case 'toFixed': return obj.toFixed(Math.max(0, Math.min(20, Number(args[0]) || 0)));
        case 'toString': return obj.toString();
        case 'toLocaleString': return obj.toLocaleString('en-MY');
        case 'round': { const f = 10 ** (Number(args[0]) || 0); return Math.round(obj * f) / f; }
        case 'floor': return Math.floor(obj);
        case 'ceil': return Math.ceil(obj);
        case 'abs': return Math.abs(obj);
        case 'toDateTime': return new FDate(obj, zone);
      }
      throw new FormulaError(`Numbers have no .${name}(). Try toFixed(2), round(), floor(), ceil()`);
    }
    if (Array.isArray(obj)) {
      const a = obj;
      if (a.length > MAX_ARR) throw new FormulaError('The list is too long for a formula');
      switch (name) {
        case 'join': return capStr(a.map(str).join(args[0] === undefined ? ',' : str(args[0])));
        case 'includes': return a.some((x) => x === args[0] || (x !== null && typeof x === 'object' ? false : String(x) === String(args[0]) && typeof x === typeof args[0]));
        case 'indexOf': return a.indexOf(args[0]);
        case 'slice': return a.slice(args[0] as number, args[1] as number);
        case 'concat': return a.concat(...args).slice(0, MAX_ARR);
        case 'at': return a.at(Number(args[0]) || 0);
        case 'map': { const f = fnArg(0); return a.map((x, i) => f(x, i)); }
        case 'filter': { const f = fnArg(0); return a.filter((x, i) => truthy(f(x, i))); }
        case 'find': { const f = fnArg(0); return a.find((x, i) => truthy(f(x, i))); }
        case 'findIndex': { const f = fnArg(0); return a.findIndex((x, i) => truthy(f(x, i))); }
        case 'some': { const f = fnArg(0); return a.some((x, i) => truthy(f(x, i))); }
        case 'every': { const f = fnArg(0); return a.every((x, i) => truthy(f(x, i))); }
        case 'reduce': { const f = fnArg(0); return args.length > 1 ? a.reduce((acc, x, i) => f(acc, x, i), args[1]) : a.reduce((acc, x, i) => f(acc, x, i)); }
        case 'flat': return a.flat(Math.min(Number(args[0] ?? 1) || 1, 5)).slice(0, MAX_ARR);
        case 'reverse': return [...a].reverse();
        case 'sort': {
          const copy = [...a];
          if (args[0] !== undefined) { const f = fnArg(0); return copy.sort((x, y) => Number(f(x, y)) || 0); }
          return copy.sort((x, y) => (typeof x === 'number' && typeof y === 'number' ? x - y : str(x).localeCompare(str(y), undefined, { numeric: true })));
        }
        // n8n helpers
        case 'first': return a[0];
        case 'last': return a[a.length - 1];
        case 'isEmpty': return a.length === 0;
        case 'isNotEmpty': return a.length > 0;
        case 'sum': return a.reduce((s: number, x) => s + (Number(x) || 0), 0);
        case 'average': return a.length ? a.reduce((s: number, x) => s + (Number(x) || 0), 0) / a.length : 0;
        case 'max': return Math.max(...a.map(Number));
        case 'min': return Math.min(...a.map(Number));
        case 'unique': return [...new Set(a.map((x) => (x !== null && typeof x === 'object' ? JSON.stringify(x) : x)))].map((x) => (typeof x === 'string' && /^[[{]/.test(x) ? JSON.parse(x) : x));
        case 'pluck': return a.map((x) => member(x, args[0]));
        case 'toString': return a.map(str).join(',');
      }
      throw new FormulaError(`Lists have no .${name}(). Try join(', '), map(x => x.name), filter(x => …), includes(…), length`);
    }
    if (obj && typeof obj === 'object' && !(obj instanceof Closure) && !(obj instanceof Builtin) && !(obj instanceof NodeJson)) {
      // A built-in namespace like Math / JSON: obj.name is a Builtin to call
      const fn = Object.prototype.hasOwnProperty.call(obj, name) ? (obj as Record<string, unknown>)[name] : undefined;
      if (fn instanceof Builtin || fn instanceof Closure) return callFn(fn, args);
      switch (name) {
        case 'isEmpty': return Object.keys(obj).length === 0;
        case 'isNotEmpty': return Object.keys(obj).length > 0;
        case 'keys': return Object.keys(obj);
        case 'values': return Object.values(obj);
        case 'hasField': case 'hasOwnProperty': return Object.prototype.hasOwnProperty.call(obj, str(args[0]));
        case 'toJsonString': return JSON.stringify(obj);
      }
    }
    if (obj === null || obj === undefined) throw new FormulaError(`Cannot use .${name}() on an empty value — the field before it is missing. Tip: add ?. like $json.name?.${name}()`);
    if (typeof obj === 'boolean' && name === 'toString') return String(obj);
    throw new FormulaError(`.${name}() is not available here`);
  }

  function truthy(v: unknown) {
    if (v instanceof Today) return true;
    return Boolean(v);
  }
  const prim = (v: unknown) => (v instanceof FDate ? v.ms : v instanceof Today ? v.info.date : v instanceof NodeJson ? v.data : v);

  function ev(n: Node, env?: Env): unknown {
    tick();
    switch (n.k) {
      case 'lit': return n.v;
      case 'tpl': return capStr(n.parts.map((p, i) => p + (i < n.exprs.length ? str(ev(n.exprs[i]!, env)) : '')).join(''));
      case 'id': return lookup(n.name, env);
      case 'arr': { const out = n.items.map((x) => ev(x, env)); if (out.length > MAX_ARR) throw new FormulaError('The list is too long'); return out; }
      case 'obj': return Object.fromEntries(n.props.map((p) => [p.key, plain(ev(p.value, env))]));
      case 'arrow': return new Closure(n.params, n.body, env ?? { vars: new Map() });
      case 'mem': {
        const o = ev(n.obj, env);
        if ((o === null || o === undefined) && n.opt) return undefined;
        return member(o, n.computed ? prim(ev(n.prop, env)) : (n.prop as { v: string }).v);
      }
      case 'call': {
        if (n.callee.k === 'mem') {
          const o = ev(n.callee.obj, env);
          if ((o === null || o === undefined) && (n.callee.opt || n.opt)) return undefined;
          const name = String(n.callee.computed ? prim(ev(n.callee.prop, env)) : (n.callee.prop as { v: string }).v);
          if (FORBIDDEN.has(name)) throw new FormulaError(`“${name}” is not allowed`);
          return method(o, name, n.args.map((a) => ev(a, env)));
        }
        const fn = ev(n.callee, env);
        if ((fn === null || fn === undefined) && n.opt) return undefined;
        return callFn(fn, n.args.map((a) => ev(a, env)));
      }
      case 'un': {
        const v = prim(ev(n.arg, env));
        if (n.op === '!') return !v;
        if (n.op === '-') return -(v as number);
        if (n.op === 'typeof') return v === null ? 'object' : Array.isArray(v) ? 'object' : typeof v;
        return +(v as number);
      }
      case 'cond': return truthy(ev(n.test, env)) ? ev(n.yes, env) : ev(n.no, env);
      case 'bin': {
        if (n.op === '&&') { const l = ev(n.l, env); return truthy(l) ? ev(n.r, env) : l; }
        if (n.op === '||') { const l = ev(n.l, env); return truthy(l) ? l : ev(n.r, env); }
        if (n.op === '??') { const l = ev(n.l, env); return l === null || l === undefined ? ev(n.r, env) : l; }
        const lv = ev(n.l, env);
        const rv = ev(n.r, env);
        if (n.op === '+') {
          const a = prim(lv);
          const b = prim(rv);
          if (typeof a === 'number' && typeof b === 'number') return a + b;
          if ((lv instanceof FDate || lv instanceof Today) && typeof b !== 'number') return capStr(str(lv) + str(rv));
          if (typeof a === 'string' || typeof b === 'string' || (a && typeof a === 'object') || (b && typeof b === 'object')) return capStr(str(lv) + str(rv));
          return (a as number) + (b as number);
        }
        const a = prim(lv) as any;
        const b = prim(rv) as any;
        switch (n.op) {
          case '-': return a - b;
          case '*': return a * b;
          case '/': return a / b;
          case '%': return a % b;
          case '==': return a == b; // eslint-disable-line eqeqeq
          case '!=': return a != b; // eslint-disable-line eqeqeq
          case '===': return a === b;
          case '!==': return a !== b;
          case '<': return a < b;
          case '>': return a > b;
          case '<=': return a <= b;
          case '>=': return a >= b;
        }
      }
    }
    throw new FormulaError('Unsupported formula');
  }

  const out = ev(ast);
  // Results leave the formula as plain data.
  if (out instanceof FDate) return out.toISO();
  if (out instanceof Today) return out.info.date;
  if (out instanceof NodeJson) return out.data;
  if (out instanceof NodeRef) return out.first;
  if (out instanceof Closure || out instanceof Builtin) return undefined;
  return out;
}
