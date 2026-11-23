import type { DailyRunStats, SystemSettings } from '@widebed/shared';
import { DEFAULT_SYSTEM_SETTINGS } from '@widebed/shared';
import type { Repositories, StoredExecution } from '../repositories/types.js';
import type { CredentialService } from './credential-service.js';

const KEY = 'system';

export interface SystemServiceDeps {
  repos: Repositories;
  credentials: CredentialService;
  publicBaseUrl: string;
  /** Web app address, used for links in alert emails. */
  webBaseUrl?: string;
  now?: () => number;
}

/**
 * Platform settings, failure alert emails and the Overview chart numbers.
 */
export class SystemService {
  /** workflowId → last alert time (ms). Per process; good enough to stop floods. */
  private lastAlert = new Map<string, number>();

  constructor(private d: SystemServiceDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  async settings(): Promise<SystemSettings> {
    const saved = (await this.d.repos.settings.get<Partial<SystemSettings>>(KEY)) ?? {};
    return { ...DEFAULT_SYSTEM_SETTINGS, ...saved, alerts: { ...DEFAULT_SYSTEM_SETTINGS.alerts, ...(saved.alerts ?? {}) }, ai: { ...DEFAULT_SYSTEM_SETTINGS.ai, ...(saved.ai ?? {}) }, code: { ...DEFAULT_SYSTEM_SETTINGS.code, ...(saved.code ?? {}) } };
  }

  async save(value: SystemSettings) {
    await this.d.repos.settings.set(KEY, value);
    return value;
  }

  /** Called by the execution service whenever a run ends as failed. Never throws. */
  async onRunFailed(executionId: string): Promise<'sent' | 'skipped' | 'error'> {
    try {
      const exec = await this.d.repos.executions.get(executionId);
      if (!exec || exec.isTestRun) return 'skipped';
      const s = (await this.settings()).alerts;
      if (!s.enabled || !s.credentialId || !s.emails.length) return 'skipped';
      const last = this.lastAlert.get(exec.workflowId) ?? 0;
      if (this.now() - last < s.cooldownMinutes * 60_000) return 'skipped';
      this.lastAlert.set(exec.workflowId, this.now());
      const wf = await this.d.repos.workflows.get(exec.workflowId);
      await this.d.credentials.sendSystemEmail(s.credentialId, s.emails, `Workflow failed: ${wf?.name ?? exec.workflowId}`, this.alertBody(exec, wf?.name));
      return 'sent';
    } catch (err) {
      console.error('[alerts] could not send failure email:', (err as Error).message);
      return 'error';
    }
  }

  private alertBody(exec: StoredExecution, name?: string) {
    const base = (this.d.webBaseUrl ?? this.d.publicBaseUrl).replace(/\/$/, '');
    return [
      `The workflow "${name ?? exec.workflowId}" did not finish.`,
      '',
      `What went wrong: ${exec.errorSummary ?? 'unknown error'}`,
      `Started by: ${exec.triggerType}`,
      `When: ${exec.completedAt ?? exec.createdAt}`,
      '',
      `Open the run to see each step: ${base}/executions/${exec.executionId}`,
      '',
      'You get at most one of these emails per workflow per cooldown period.',
      'Change who receives them in Settings → Failure alerts.',
    ].join('\n');
  }

  async sendTest(): Promise<void> {
    const s = (await this.settings()).alerts;
    if (!s.credentialId) throw new Error('Pick a Google connection first');
    if (!s.emails.length) throw new Error('Add at least one email address');
    await this.d.credentials.sendSystemEmail(s.credentialId, s.emails, 'Test alert from Widebed Automation', 'This is a test. Failure alerts are set up correctly.');
  }

  /**
   * Runs per day for the last `days` days (oldest first), counted in the given time zone.
   * `list` returns the runs the user may see.
   */
  static bucketByDay(rows: Pick<StoredExecution, 'createdAt' | 'status'>[], days: number, timeZone: string, now = Date.now()): DailyRunStats[] {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const out: DailyRunStats[] = [];
    const index = new Map<string, DailyRunStats>();
    for (let i = days - 1; i >= 0; i--) {
      const date = fmt.format(new Date(now - i * 86400_000));
      if (index.has(date)) continue;
      const d = { date, success: 0, failed: 0, other: 0 };
      index.set(date, d);
      out.push(d);
    }
    for (const r of rows) {
      const d = index.get(fmt.format(new Date(r.createdAt)));
      if (!d) continue;
      if (r.status === 'success') d.success++;
      else if (r.status === 'failed') d.failed++;
      else d.other++;
    }
    return out;
  }
}

export function validTimeZone(tz: unknown, fallback = 'Asia/Kuala_Lumpur'): string {
  if (typeof tz !== 'string' || !tz) return fallback;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}
