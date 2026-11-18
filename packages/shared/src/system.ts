/**
 * Admin-editable platform settings (Settings → System, Super Admin only).
 * Stored in the `settings` collection under the key "system".
 */
export interface SystemSettings {
  alerts: {
    /** Email people when a live (published) run fails. */
    enabled: boolean;
    /** Who gets the email. */
    emails: string[];
    /** Google connection (Credentials page) used to send the email. */
    credentialId: string | null;
    /** At most one email per workflow in this many minutes, so a broken schedule doesn't flood the inbox. */
    cooldownMinutes: number;
  };
  /** AI staff rules set by Admins (Approval Center). */
  ai: {
    lowRiskPolicy: import('./approvals.js').LowRiskPolicy;
    /** Hours before an unanswered approval expires (critical ones: at most 2 hours). */
    approvalHours: number;
  };
}

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  alerts: { enabled: false, emails: [], credentialId: null, cooldownMinutes: 60 },
  ai: { lowRiskPolicy: 'auto_in_chat', approvalHours: 24 },
};

/** One day on the Overview chart. `date` is YYYY-MM-DD in the server's local calendar. */
export interface DailyRunStats {
  date: string;
  success: number;
  failed: number;
  other: number;
}

/** Small public view of a person, used when sharing workflows. */
export interface PersonSummary {
  uid: string;
  name: string;
  email: string;
  department: string | null;
}

export const BACKUP_FORMAT = 'widebed-automation/backup';
