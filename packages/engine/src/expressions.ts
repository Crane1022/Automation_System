import { todayInfo, type Item } from '@widebed/shared';

/**
 * Expression support for node fields: `{{ path }}`.
 *
 * This is deliberately NOT JavaScript. Only property paths are allowed,
 * so there is nothing to sandbox:
 *
 *   {{ $json.body.bookingId }}          current item
 *   {{ $json["guest name"] }}           bracket keys
 *   {{ $json.rooms[0].number }}         array index
 *   {{ $node["HTTP Request"].json.id }} first output item of a node (by name or id)
 *   {{ $trigger.body.email }}           first item of the trigger node
 *   {{ $execution.id }}  {{ $workflow.id }}  {{ $now }}  {{ $itemIndex }}
 *
 * If a field is exactly one expression, the raw value is returned (keeps
 * numbers/objects). Otherwise the results are joined into a string.
 */

export interface ExpressionScope {
  item?: Item;
  itemIndex?: number;
  /** First output item json of each executed node, keyed by node id and name. */
  nodes: Record<string, Record<string, unknown> | undefined>;
  trigger?: Record<string, unknown>;
  executionId: string;
  workflowId: string;
  now?: () => string;
  /** Time zone for {{ $today }} (default Malaysia). */
  timezone?: string;
}

const TEMPLATE = /\{\{\s*([\s\S]+?)\s*\}\}/g;
const SINGLE = /^\{\{\s*([\s\S]+?)\s*\}\}$/;

export class ExpressionError extends Error {}

type Segment = string | number;

/** Parses `$root.a["b c"][0]` into ["$root", "a", "b c", 0]. */
export function parsePath(expr: string): Segment[] {
  const s = expr.trim();
  const segs: Segment[] = [];
  let i = 0;
  const ident = /[A-Za-z_$][\w$]*/y;
  ident.lastIndex = 0;
  const first = ident.exec(s);
  if (!first) throw new ExpressionError(`Invalid expression "${expr}"`);
  segs.push(first[0]);
  i = ident.lastIndex;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '.') {
      ident.lastIndex = i + 1;
      const m = ident.exec(s);
      if (!m) throw new ExpressionError(`Invalid property after "." in "${expr}"`);
      segs.push(m[0]);
      i = ident.lastIndex;
    } else if (ch === '[') {
      const rest = s.slice(i);
      const m = rest.match(/^\[\s*(?:(\d+)|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\]/);
      if (!m) throw new ExpressionError(`Invalid [...] access in "${expr}"`);
      if (m[1] !== undefined) segs.push(Number(m[1]));
      else segs.push((m[2] ?? m[3]).replace(/\\(.)/g, '$1'));
      i += m[0].length;
    } else if (/\s/.test(ch)) {
      i++;
    } else {
      throw new ExpressionError(`Unsupported syntax "${s.slice(i)}" in "${expr}". Only property paths are allowed.`);
    }
  }
  return segs;
}

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

function walk(root: unknown, path: Segment[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === 'string' && FORBIDDEN.has(seg)) return undefined;
    if (typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

export function evaluatePath(expr: string, scope: ExpressionScope): unknown {
  const [root, ...rest] = parsePath(expr);
  switch (root) {
    case '$json':
      return walk(scope.item?.json ?? {}, rest);
    case '$node': {
      const [name, ...path] = rest;
      if (name === undefined) throw new ExpressionError('$node needs a node name, e.g. $node["HTTP Request"].json');
      const data = scope.nodes[String(name)];
      // Allow both $node["X"].json.a and $node["X"].a
      const p = path[0] === 'json' ? path.slice(1) : path;
      return walk(data ?? {}, p);
    }
    case '$trigger':
      return walk(scope.trigger ?? {}, rest);
    case '$execution':
      return walk({ id: scope.executionId }, rest);
    case '$workflow':
      return walk({ id: scope.workflowId }, rest);
    case '$now':
      return (scope.now ?? (() => new Date().toISOString()))();
    case '$itemIndex':
      return scope.itemIndex ?? 0;
    case '$today': {
      const info = todayInfo(new Date(scope.now ? scope.now() : Date.now()), scope.timezone);
      return rest.length ? walk(info, rest) : info.date;
    }
    default:
      throw new ExpressionError(`Unknown variable "${root}". Use $json, $node, $trigger, $execution, $workflow, $now, $today or $itemIndex.`);
  }
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export function resolveString(text: string, scope: ExpressionScope): unknown {
  const single = text.match(SINGLE);
  if (single && !single[1].includes('}}')) return evaluatePath(single[1], scope);
  return text.replace(TEMPLATE, (_m, expr: string) => stringify(evaluatePath(expr, scope)));
}

/** Deeply resolves every string inside a value. */
export function resolveValue<T>(value: T, scope: ExpressionScope, depth = 0): T {
  if (depth > 20) return value;
  if (typeof value === 'string') return (value.includes('{{') ? resolveString(value, scope) : value) as T;
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, scope, depth + 1)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, scope, depth + 1);
    return out as T;
  }
  return value;
}
