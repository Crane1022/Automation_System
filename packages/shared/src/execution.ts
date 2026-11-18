export const EXECUTION_STATUSES = [
  'pending',
  'queued',
  'running',
  'waiting',
  'success',
  'failed',
  'cancelled',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const TERMINAL_STATUSES: ExecutionStatus[] = ['success', 'failed', 'cancelled'];

/** Node steps also have "skipped" (branch not taken / no input items). */
export type StepStatus = 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';

export type TriggerType = 'manual' | 'webhook' | 'schedule' | 'http_event' | 'retry';

export interface Execution {
  executionId: string;
  workflowId: string;
  workflowName: string;
  department: string | null;
  /** Version number executed, or null for a draft test run. */
  workflowVersion: number | null;
  workflowVersionId: string | null;
  /** True when a draft (unpublished) definition was executed from the editor. */
  isTestRun: boolean;
  status: ExecutionStatus;
  triggerType: TriggerType;
  initiatedBy: string | null;
  idempotencyKey: string | null;
  /** When retrying, the execution this one retries. */
  retryOf: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  duration: number | null;
  errorSummary: string | null;
  /** Counts kept on the parent so list pages need no subcollection reads. */
  stepCount: number;
}

export interface StepError {
  message: string;
  code?: string;
  retryable?: boolean;
}

export interface ExecutionStep {
  stepId: string;
  executionId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: StepStatus;
  attempt: number;
  /** Redacted and size-limited. */
  inputData: unknown;
  outputData: unknown;
  error: StepError | null;
  startedAt: string;
  completedAt: string | null;
  duration: number | null;
}

/** Events pushed to the frontend over Server-Sent Events. */
export type ExecutionEvent =
  | { type: 'execution.status'; executionId: string; status: ExecutionStatus; errorSummary?: string | null; duration?: number | null }
  | { type: 'step.started'; executionId: string; step: ExecutionStep }
  | { type: 'step.finished'; executionId: string; step: ExecutionStep };
