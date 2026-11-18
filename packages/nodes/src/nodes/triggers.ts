import { z } from 'zod';
import cronParser from 'cron-parser';
import { DATE_RE, DAY_OF_MONTH_OPTIONS, SCHEDULE_MODE_OPTIONS, TIME_RE, TIMEZONE_OPTIONS, WEEKDAY_OPTIONS } from '@widebed/shared';
import { defineNode } from '../types.js';

/** Validates a 5-field cron expression in a time zone. Returns an error message or null. */
export function cronError(expr: string, tz: string): string | null {
  if (expr.trim().split(/\s+/).length !== 5) return 'Use 5 fields: minute hour day month weekday';
  try {
    cronParser.parseExpression(expr, { tz });
    return null;
  } catch (err) {
    return `Invalid cron expression: ${(err as Error).message}`;
  }
}

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- Schedule */

export const scheduleTriggerSchema = z
  .object({
    // Default stays "interval" so old saved nodes without a mode keep working.
    // New nodes get "daily" from the field default below.
    mode: z.enum(['once', 'daily', 'weekly', 'monthly', 'interval', 'cron']).default('interval'),
    date: z.string().default(''),
    time: z.string().default('09:00'),
    weekdays: z.array(z.string()).default(['1']),
    dayOfMonth: z.string().default('1'),
    every: z.coerce.number().int().min(1).default(15),
    unit: z.enum(['minutes', 'hours', 'days']).default('minutes'),
    cron: z.string().default('0 9 * * *'),
    timezone: z.string().default('Asia/Kuala_Lumpur'),
  })
  .superRefine((c, ctx) => {
    if (!validTimeZone(c.timezone)) ctx.addIssue({ code: 'custom', path: ['timezone'], message: 'Unknown time zone' });
    if (['once', 'daily', 'weekly', 'monthly'].includes(c.mode) && !TIME_RE.test(c.time)) {
      ctx.addIssue({ code: 'custom', path: ['time'], message: 'Choose a time' });
    }
    if (c.mode === 'once') {
      const d = DATE_RE.exec(c.date);
      const real = d && new Date(Date.UTC(+d[1], +d[2] - 1, +d[3])).getUTCDate() === +d[3];
      if (!real) ctx.addIssue({ code: 'custom', path: ['date'], message: 'Choose a date' });
    }
    if (c.mode === 'weekly') {
      if (!c.weekdays.length) ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'Choose at least one day' });
      if (c.weekdays.some((d) => !/^[0-6]$/.test(d))) ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'Unknown day' });
    }
    if (c.mode === 'monthly' && !/^([1-9]|[12]\d|3[01]|L)$/.test(c.dayOfMonth)) {
      ctx.addIssue({ code: 'custom', path: ['dayOfMonth'], message: 'Choose a day of the month' });
    }
    if (c.mode === 'cron') {
      const e = cronError(c.cron, validTimeZone(c.timezone) ? c.timezone : 'UTC');
      if (e) ctx.addIssue({ code: 'custom', path: ['cron'], message: e });
    }
  });

export type ScheduleConfig = z.infer<typeof scheduleTriggerSchema>;

const SIMPLE_TIME = ['once', 'daily', 'weekly', 'monthly'];

export const scheduleTrigger = defineNode({
  descriptor: {
    type: 'trigger.schedule',
    version: 1,
    displayName: 'Schedule Trigger',
    description: 'Start the workflow on a date, every day, every week, every month or every few minutes.',
    category: 'trigger',
    icon: 'clock',
    isTrigger: true,
    inputs: [],
    outputs: [{ id: 'main' }],
    fields: [
      { key: 'mode', label: 'When should it run?', type: 'select', default: 'daily', options: SCHEDULE_MODE_OPTIONS },
      { key: 'date', label: 'Date', type: 'date', required: true, showIf: { key: 'mode', equals: ['once'] } },
      { key: 'weekdays', label: 'On these days', type: 'multiSelect', default: ['1'], options: WEEKDAY_OPTIONS, showIf: { key: 'mode', equals: ['weekly'] } },
      { key: 'dayOfMonth', label: 'On day', type: 'select', default: '1', options: DAY_OF_MONTH_OPTIONS, showIf: { key: 'mode', equals: ['monthly'] }, help: 'Months without this day (e.g. the 31st) are skipped. Pick “Last day of the month” to run every month.' },
      { key: 'time', label: 'Time', type: 'time', default: '09:00', required: true, showIf: { key: 'mode', equals: SIMPLE_TIME } },
      { key: 'every', label: 'Every', type: 'number', default: 15, showIf: { key: 'mode', equals: ['interval'] } },
      {
        key: 'unit',
        label: 'Unit',
        type: 'select',
        default: 'minutes',
        showIf: { key: 'mode', equals: ['interval'] },
        options: [
          { label: 'Minutes', value: 'minutes' },
          { label: 'Hours', value: 'hours' },
          { label: 'Days', value: 'days' },
        ],
      },
      {
        key: 'cron',
        label: 'Cron expression',
        type: 'string',
        default: '0 9 * * *',
        showIf: { key: 'mode', equals: ['cron'] },
        help: 'For IT users. minute hour day month weekday. Examples: “0 9 * * *” daily 9:00 · “0 9 * * 1-5” weekdays 9:00 · “*/30 8-18 * * *” every 30 min, 8:00–18:59.',
      },
      { key: 'timezone', label: 'Time zone', type: 'timezone', default: 'Asia/Kuala_Lumpur', options: TIMEZONE_OPTIONS },
    ],
    inputSchema: { description: 'No input.' },
    outputSchema: {
      description: 'One item with the time the run was scheduled for.',
      example: [{ json: { scheduledFor: '2026-11-14T01:00:00.000Z', timezone: 'Asia/Kuala_Lumpur' } }],
    },
    retryable: true,
    available: true,
    docs: [
      '### Schedule Trigger',
      'Runs the **published** version while the workflow is **Active**. Deactivating stops the schedule.',
      '- **Once**: runs one time on the date and time you pick, then stops.',
      '- **Every day / week / month**: pick the time (and days). Times are in the chosen time zone.',
      '- **Every few minutes / hours**: counts from when the workflow was activated.',
      '- **Advanced (cron)**: for IT users who know cron expressions.',
      '',
      'Each scheduled time starts at most one execution, even if several servers are running.',
      '',
      'In the editor, *Test run* fires it once immediately.',
    ].join('\n'),
  },
  configSchema: scheduleTriggerSchema,
  async execute(ctx) {
    return { outputs: { main: ctx.items.length ? ctx.items : [{ json: { scheduledFor: new Date().toISOString(), timezone: ctx.config.timezone, test: true } }] } };
  },
});

/* ---------------------------------------------------------------- HTTP Event */

export const EVENT_NAME = /^[a-z0-9][a-z0-9_.-]{0,99}$/;

export const eventTrigger = defineNode({
  descriptor: {
    type: 'trigger.event',
    version: 1,
    displayName: 'HTTP Event Trigger',
    description: 'Start when an internal app (PMS, TMS…) reports an event such as booking.created.',
    category: 'trigger',
    icon: 'radio',
    isTrigger: true,
    inputs: [],
    outputs: [{ id: 'main' }],
    fields: [
      {
        key: 'eventName',
        label: 'Event name',
        type: 'string',
        required: true,
        placeholder: 'booking.created',
        help: 'Lower-case letters, numbers, dots, dashes and underscores.',
      },
      { key: 'testData', label: 'Test data (JSON)', type: 'json', default: '{}', help: 'Used as the event data for Test run.' },
    ],
    inputSchema: { description: 'No input.' },
    outputSchema: {
      description: 'One item per event.',
      example: [{ json: { event: 'booking.created', source: 'PMS', data: { bookingId: 'B-102' }, receivedAt: '2026-11-13T07:00:00Z' } }],
    },
    retryable: true,
    available: true,
    docs: [
      '### HTTP Event Trigger',
      'Unlike a webhook (one secret URL per workflow), events are **named** and **shared**:',
      'PMS sends `booking.created` once and **every active workflow** listening to that name starts.',
      '',
      'An administrator creates an **Event source** credential (one per app). The app sends:',
      '```',
      'POST /events/booking.created',
      'Authorization: Bearer <event source key>',
      '{ "bookingId": "B-102" }',
      '```',
      'Add `Idempotency-Key` to make retries from the app safe. Read the data with `{{ $json.data.bookingId }}`.',
    ].join('\n'),
  },
  configSchema: z.object({
    eventName: z.string().trim().regex(EVENT_NAME, 'Use lower-case letters, numbers, “.”, “-” and “_”'),
    testData: z.string().optional(),
  }),
  async execute(ctx) {
    if (ctx.items.length) return { outputs: { main: ctx.items } };
    let data: unknown = {};
    try {
      data = ctx.config.testData?.trim() ? JSON.parse(ctx.config.testData) : {};
    } catch {
      /* invalid test data → empty object */
    }
    return { outputs: { main: [{ json: { event: ctx.config.eventName, source: 'test', data, receivedAt: new Date().toISOString() } }] } };
  },
});
