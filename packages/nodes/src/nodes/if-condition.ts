import { z } from 'zod';
import { daysBetween, parseDay, DEFAULT_TIMEZONE, dayInZone, type Item } from '@widebed/shared';
import { defineNode } from '../types.js';

export const OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
  'isEmpty',
  'isNotEmpty',
  'isTrue',
  'isFalse',
  // Dates (whole days, Malaysia time). The right-hand value is a number of days where needed.
  'isToday',
  'isTomorrow',
  'isYesterday',
  'isInPast',
  'isInFuture',
  'isDaysFromToday',
  'withinNextDays',
  'withinLastDays',
  'moreThanDaysAgo',
] as const;
export type Operator = (typeof OPERATORS)[number];

/** Operators that ignore the right-hand value. */
export const UNARY_OPERATORS: Operator[] = ['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse', 'isToday', 'isTomorrow', 'isYesterday', 'isInPast', 'isInFuture'];

/** Date operators: the left value must be a date; a value that is not a date never matches. */
export const DATE_OPERATORS: Operator[] = ['isToday', 'isTomorrow', 'isYesterday', 'isInPast', 'isInFuture', 'isDaysFromToday', 'withinNextDays', 'withinLastDays', 'moreThanDaysAgo'];

export interface ConditionOptions {
  now?: Date;
  timezone?: string;
}

const conditionSchema = z.object({
  left: z.unknown(),
  operator: z.enum(OPERATORS),
  right: z.unknown().optional(),
});

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

function asText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export function evaluateCondition(left: unknown, operator: Operator, right: unknown, opts: ConditionOptions = {}): boolean {
  if (DATE_OPERATORS.includes(operator)) {
    const tz = opts.timezone ?? DEFAULT_TIMEZONE;
    const day = parseDay(left, tz);
    if (!day) return false;
    const diff = daysBetween(dayInZone(opts.now ?? new Date(), tz), day); // + = in the future
    const n = toNumber(right);
    switch (operator) {
      case 'isToday': return diff === 0;
      case 'isTomorrow': return diff === 1;
      case 'isYesterday': return diff === -1;
      case 'isInPast': return diff < 0;
      case 'isInFuture': return diff > 0;
      case 'isDaysFromToday': return n !== null && diff === n;
      case 'withinNextDays': return n !== null && diff >= 0 && diff <= n;
      case 'withinLastDays': return n !== null && diff <= 0 && -diff <= n;
      case 'moreThanDaysAgo': return n !== null && -diff > n;
      default: return false;
    }
  }
  const ln = toNumber(left);
  const rn = toNumber(right);
  switch (operator) {
    case 'equals':
      return ln !== null && rn !== null ? ln === rn : asText(left) === asText(right);
    case 'notEquals':
      return !evaluateCondition(left, 'equals', right);
    case 'contains':
      return Array.isArray(left) ? left.some((x) => asText(x) === asText(right)) : asText(left).includes(asText(right));
    case 'notContains':
      return !evaluateCondition(left, 'contains', right);
    case 'startsWith':
      return asText(left).startsWith(asText(right));
    case 'endsWith':
      return asText(left).endsWith(asText(right));
    case 'greaterThan':
      return ln !== null && rn !== null && ln > rn;
    case 'greaterThanOrEqual':
      return ln !== null && rn !== null && ln >= rn;
    case 'lessThan':
      return ln !== null && rn !== null && ln < rn;
    case 'lessThanOrEqual':
      return ln !== null && rn !== null && ln <= rn;
    case 'isEmpty':
      return isEmpty(left);
    case 'isNotEmpty':
      return !isEmpty(left);
    case 'isTrue':
      return left === true || asText(left).toLowerCase() === 'true';
    case 'isFalse':
      return left === false || asText(left).toLowerCase() === 'false';
    default:
      return false;
  }
}

export const ifCondition = defineNode({
  descriptor: {
    type: 'logic.if',
    version: 1,
    displayName: 'IF Condition',
    description: 'Route each item to the “true” or “false” branch based on conditions.',
    category: 'logic',
    icon: 'git-branch',
    isTrigger: false,
    inputs: [{ id: 'main' }],
    outputs: [
      { id: 'true', label: 'true' },
      { id: 'false', label: 'false' },
    ],
    fields: [
      {
        key: 'conditions',
        label: 'Conditions',
        type: 'conditions',
        required: true,
        expressions: true,
        default: [{ left: '', operator: 'equals', right: '' }],
        help: 'Use expressions such as {{ $json.status }} on either side.',
      },
      {
        key: 'combine',
        label: 'Combine conditions with',
        type: 'select',
        default: 'and',
        options: [
          { label: 'AND — all must match', value: 'and' },
          { label: 'OR — any may match', value: 'or' },
        ],
      },
    ],
    inputSchema: { description: 'Any items.' },
    outputSchema: { description: 'The same items, split between the true and false outputs.' },
    retryable: false,
    available: true,
    docs: [
      '### IF Condition',
      'Each incoming item is tested. Matching items go to **true**, the rest go to **false**.',
      'A branch that receives no items is skipped, together with the nodes after it.',
      '',
      'Numbers are compared numerically when both sides look like numbers (`"10"` equals `10`).',
      'Text comparisons are case-sensitive.',
    ].join('\n'),
  },
  configSchema: z.object({
    conditions: z.array(conditionSchema).min(1, 'Add at least one condition'),
    combine: z.enum(['and', 'or']).default('and'),
  }),
  async execute(ctx) {
    const truthy: Item[] = [];
    const falsy: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const item = ctx.items[i];
      const results = ctx.config.conditions.map((c) => {
        const left = ctx.resolve(c.left, item, i);
        const right = ctx.resolve(c.right, item, i);
        return evaluateCondition(left, c.operator, right);
      });
      const pass = ctx.config.combine === 'or' ? results.some(Boolean) : results.every(Boolean);
      (pass ? truthy : falsy).push(item);
    }
    return { outputs: { true: truthy, false: falsy } };
  },
});
