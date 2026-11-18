import type { AssistantFile } from './assistant.js';
import type { ScheduleSettings } from './schedule.js';

/**
 * AI Staff background work.
 *
 * Firestore (server only):
 *   aiTasks/{taskId}         one piece of work done by an AI employee in the background
 *   aiSchedules/{id}         recurring work ("every day at 7:00 check arrivals")
 *
 * A task always runs with the permissions of a real person (`runAsId`): the one who
 * gave it, or the one who made the schedule. An AI employee never gets more access
 * than that person has.
 */

export type AgentTaskStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
export type AgentTaskSource = 'manual' | 'schedule' | 'followup' | 'delegation';
export type AgentTaskPriority = 'low' | 'normal' | 'high';

export interface AgentTaskStep {
  label: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
  at: string;
}

export interface AgentTask {
  taskId: string;
  agentId: string;
  agentName: string;
  title: string;
  instructions: string;
  source: AgentTaskSource;
  scheduleId: string | null;
  /** Whose permissions it runs with. */
  runAsId: string;
  createdBy: string;
  /** The AI employee's department (for department managers' view). */
  department: string | null;
  priority: AgentTaskPriority;
  status: AgentTaskStatus;
  attempt: number;
  maxAttempts: number;
  steps: AgentTaskStep[];
  output: string | null;
  error: string | null;
  files: AssistantFile[];
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  /** Set for scheduled runs: one task per schedule occurrence. */
  occurrenceKey: string | null;
  /** Long-term responsibility this work belongs to (via its schedule), if any. */
  responsibilityId?: string | null;
  /** The task that found the problem this follow-up is about. */
  parentTaskId?: string | null;
  /** Unresolved problems the AI reported (responsibility runs). */
  issues?: AgentIssueReport[];
  /** Delegated by a manager: the shared project, and the tasks it waits for. */
  projectId?: string | null;
  dependsOn?: string[];
  /** Tools it may use at most (the manager's), so delegating never adds permissions. */
  toolLimit?: import('./agents.js').AgentTools | null;
  /** While waiting for a person: the approval it waits for. */
  approvalId?: string | null;
  /** The conversation so far, so the task can continue after a decision (server use). */
  transcriptJson?: string | null;
  /** The decision to continue with on the next run (server use). */
  resume?: { tool: string; input: unknown; approved: boolean; approvalId: string } | null;
}

/** One problem an AI employee reported at the end of a responsibility run. */
export interface AgentIssueReport {
  /** Short stable id the AI gives the problem, e.g. "A-12-aircon", so the same problem is recognised next time. */
  key: string;
  text: string;
}

/** Repeat rule + the time zone it is read in. */
export type AgentScheduleRule = ScheduleSettings & { timezone: string };

export interface AgentSchedule {
  scheduleId: string;
  name: string;
  agentId: string;
  /** What to do each time, in plain words. */
  instructions: string;
  rule: AgentScheduleRule;
  /** YYYY-MM-DD; runs before this date are skipped. */
  startDate: string | null;
  /** YYYY-MM-DD; after this date the schedule switches itself off. */
  endDate: string | null;
  priority: AgentTaskPriority;
  enabled: boolean;
  /** Runs with this person's permissions (who made it). */
  runAsId: string;
  createdBy: string;
  department: string | null;
  lastRunAt: string | null;
  lastTaskId: string | null;
  lastStatus: AgentTaskStatus | null;
  /** Who hears about each run: only failures (default), every run, or nobody. */
  notify?: 'failures' | 'always' | 'off';
  /** Long-term responsibility this schedule carries out. */
  responsibilityId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A permanent duty of an AI employee ("Monitor outstanding utility bills"), carried out by
 * its schedules. Problems found stay on the list until a later run no longer reports them.
 *   Firestore: aiResponsibilities/{id}
 */
export interface AgentResponsibility {
  responsibilityId: string;
  agentId: string;
  title: string;
  description: string;
  status: 'active' | 'paused';
  /** Give the AI employee a follow-up task for each NEW problem (once per problem). */
  autoFollowUp: boolean;
  openIssues: AgentOpenIssue[];
  /** Recently solved problems (newest first, kept short). */
  resolvedIssues: AgentOpenIssue[];
  runs: number;
  lastRunAt: string | null;
  lastTaskId: string | null;
  createdBy: string;
  department: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentOpenIssue {
  key: string;
  text: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** How many runs in a row reported it. */
  seenCount: number;
  firstTaskId: string;
  followUpTaskId: string | null;
  resolvedAt?: string;
}

export type AgentResponsibilityView = AgentResponsibility & {
  agentName: string;
  agentAvatar: string;
  agentColor: string;
  schedules: { scheduleId: string; name: string; describe: string; enabled: boolean }[];
  canEdit: boolean;
};

/* ---------------------------------------------------------- collaboration */

/**
 * One request a manager split between AI staff.
 *   Firestore: aiProjects/{projectId}
 */
export interface AgentProject {
  projectId: string;
  managerAgentId: string;
  managerName: string;
  requestedFor: string;
  /** What the manager asked the team, in short. */
  request: string;
  chatId: string | null;
  taskId: string | null;
  subtaskIds: string[];
  status: 'running' | 'done' | 'partial' | 'failed' | 'cancelled';
  createdAt: string;
  completedAt: string | null;
}

export type AgentProjectView = AgentProject & {
  managerAvatar: string;
  managerColor: string;
  requestedForName: string;
  subtasks: Pick<AgentTask, 'taskId' | 'agentId' | 'agentName' | 'title' | 'instructions' | 'status' | 'output' | 'error' | 'dependsOn' | 'startedAt' | 'completedAt' | 'durationMs' | 'approvalId'>[];
};

/** Limits that keep delegation safe and affordable. */
export const DELEGATION_LIMITS = { maxSubtasks: 6, maxRounds: 2, parallel: 3 };

/* ------------------------------------------------------------ notifications */

export type NotificationKind = 'task.completed' | 'task.failed' | 'issue.new' | 'followup.created' | 'approval.needed' | 'approval.decided';

/**
 * In-app notice for one person (the bell). Says only what that person may already see.
 *   Firestore: aiNotifications/{id}
 */
export interface AppNotification {
  notificationId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Page to open, e.g. /ai-tasks?task=… */
  link: string | null;
  agentId: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationPrefs {
  taskCompleted: boolean;
  taskFailed: boolean;
  issues: boolean;
  /** An AI employee asks for approval, or your request was decided. */
  approvals: boolean;
  /** Pop-up notices from the browser while the app is open in a tab. */
  browser: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { taskCompleted: true, taskFailed: true, issues: true, approvals: true, browser: false };

/** Splits the ```issues block off an AI answer. */
export function extractIssues(answer: string): { text: string; issues: AgentIssueReport[] } {
  const m = /```issues[^\n]*\n([\s\S]*?)(```|$)/i.exec(answer);
  if (!m) return { text: answer, issues: [] };
  const issues: AgentIssueReport[] = [];
  for (const line of m[1]!.split('\n')) {
    const t = line.replace(/^\s*[-*•]\s*/, '').trim();
    if (!t || /^none$/i.test(t)) continue;
    const [k, ...rest] = t.split('|');
    const text = rest.join('|').trim() || k!.trim();
    const key = k!.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    if (key && !issues.some((i) => i.key === key)) issues.push({ key, text: text.slice(0, 300) });
    if (issues.length >= 30) break;
  }
  return { text: (answer.slice(0, m.index) + answer.slice(m.index + m[0].length)).trim(), issues };
}

/** What to do each time … */
export const ISSUES_INSTRUCTION =
  'This run is part of a long-term responsibility. At the very end of your answer, list every UNRESOLVED problem you found in a block that starts with ```issues and ends with ```. One line per problem: a short id that stays the same for the same problem next time (e.g. a12-aircon-broken), then " | ", then the problem in one sentence. If there are none, write a line "none" in the block.';

/** What the Schedules page shows (plus plain-English timing). */
export type AgentScheduleView = AgentSchedule & {
  agentName: string;
  agentAvatar: string;
  agentColor: string;
  describe: string;
  nextRunAt: string | null;
  canEdit: boolean;
};

export const DEFAULT_SCHEDULE_RULE: AgentScheduleRule = { mode: 'daily', time: '08:00', weekdays: ['1'], dayOfMonth: '1', every: 1, unit: 'hours', date: '', cron: '0 8 * * *', timezone: 'Asia/Kuala_Lumpur' };

/** Ready-made ideas shown when making a schedule. */
export const SCHEDULE_IDEAS: { templateId: string; name: string; time: string; instructions: string }[] = [
  { templateId: 'pms-assistant', name: 'Today’s arrivals', time: '07:00', instructions: 'List every guest arriving today: guest name, unit, check-in time and number of nights. Flag anything unusual (missing details, double bookings).' },
  { templateId: 'pms-assistant', name: 'Today’s departures', time: '08:00', instructions: 'List every guest checking out today with unit and check-out time, so housekeeping can plan cleaning.' },
  { templateId: 'pms-assistant', name: 'Occupancy summary', time: '18:00', instructions: 'Summarise today’s occupancy: how many units are occupied, arriving, departing and empty.' },
  { templateId: 'finance-assistant', name: 'Outstanding utility bills', time: '08:00', instructions: 'Check outstanding utility bills and list each with unit, provider, amount (RM) and due date. Overdue first.' },
  { templateId: 'hr-assistant', name: 'Missing clock-ins', time: '12:00', instructions: 'Find staff who should be working today but have not clocked in yet. List name and expected start time.' },
  { templateId: 'operations-assistant', name: 'Unresolved issues', time: '08:30', instructions: 'List unresolved operational issues, oldest first: unit, what is wrong, how many days open and who has it.' },
  { templateId: 'operations-assistant', name: 'Daily operations summary', time: '17:30', instructions: 'Write today’s operations summary: issues opened and closed, overdue maintenance, and the 3 most urgent things for tomorrow.' },
];
