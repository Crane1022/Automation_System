/**
 * Reusable custom steps ("My team's steps").
 *
 * Someone sets up a step once (for example an HTTP Request to the booking
 * system with the URL, method and API key already filled in), picks which
 * boxes the team may still change, and saves it. Everyone in that team then
 * finds it in the step list. In a workflow it is a `util.customStep` node that
 * only stores the step id and the values of the chosen boxes; the rest of the
 * settings stay in the saved step, so a fix to the saved step reaches every
 * workflow that uses it.
 */

export const CUSTOM_STEP_TYPE = 'util.customStep';

/** Step types that cannot be saved as a reusable step. */
export const CUSTOM_STEP_BLOCKED_TYPES = ['data.code', CUSTOM_STEP_TYPE, 'util.unsupported'];

/** One box the team may change. `key` is a setting of the original step. */
export interface CustomStepField {
  key: string;
  label: string;
  help?: string;
}

export interface CustomStep {
  stepId: string;
  name: string;
  description: string;
  icon: string;
  /** Step type it is built on, e.g. "data.httpRequest". */
  baseType: string;
  /** All settings of the original step (connections included). */
  baseConfig: Record<string, unknown>;
  /** Connection of steps that pick one at the step level (Gmail, Google Sheets, AI, Firebase). */
  credentialId?: string | null;
  /** Boxes shown to the people who use it; everything else is fixed. */
  fields: CustomStepField[];
  /** Team that gets it; null = everyone in the company. */
  department: string | null;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
}

/** Settings a custom step runs with: the saved settings plus the values chosen in the workflow. */
export function customStepConfig(step: Pick<CustomStep, 'baseConfig' | 'fields'>, values: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(step.baseConfig ?? {}));
  const allowed = new Set(step.fields.map((f) => f.key));
  for (const [k, v] of Object.entries(values ?? {})) {
    if (!allowed.has(k) || v === undefined) continue;
    // An empty box means "use the saved value".
    if (v === '' || v === null) continue;
    out[k] = v;
  }
  return out;
}

/** Whether a user can see / use a step saved for a team. */
export function customStepVisible(step: Pick<CustomStep, 'department'>, department: string | null, seesAll: boolean): boolean {
  return seesAll || step.department === null || step.department === department;
}
