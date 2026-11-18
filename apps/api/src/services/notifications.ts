import { DEFAULT_NOTIFICATION_PREFS, type AppNotification, type AppUser, type NotificationKind, type NotificationPrefs } from '@widebed/shared';
import type { Repositories } from '../repositories/types.js';
import { notFound } from '../lib/http-error.js';
import { newId, nowIso } from '../lib/ids.js';

const PREF_KIND: Record<NotificationKind, keyof NotificationPrefs> = {
  'task.completed': 'taskCompleted',
  'task.failed': 'taskFailed',
  'issue.new': 'issues',
  'followup.created': 'issues',
  'approval.needed': 'approvals',
  'approval.decided': 'approvals',
};

/**
 * In-app notifications (the bell). The caller decides WHO may hear about something;
 * this service respects each person's preferences and never sends to inactive accounts.
 */
export class NotificationService {
  constructor(private repos: Repositories) {}

  async prefs(userId: string): Promise<NotificationPrefs> {
    return { ...DEFAULT_NOTIFICATION_PREFS, ...((await this.repos.settings.get<Partial<NotificationPrefs>>(`notify:${userId}`)) ?? {}) };
  }

  async savePrefs(userId: string, p: NotificationPrefs) {
    await this.repos.settings.set(`notify:${userId}`, p);
    return p;
  }

  /** Sends one notice to each person (once each), if they want this kind. Never throws. */
  async notify(userIds: string[], n: { kind: NotificationKind; title: string; body: string; link?: string | null; agentId?: string | null }) {
    let sent = 0;
    for (const userId of [...new Set(userIds)]) {
      try {
        const u = await this.repos.users.get(userId);
        if (!u || u.status !== 'active') continue;
        if (!(await this.prefs(userId))[PREF_KIND[n.kind]]) continue;
        const item: AppNotification = {
          notificationId: newId('ntf'),
          userId,
          kind: n.kind,
          title: n.title.slice(0, 120),
          body: n.body.slice(0, 300),
          link: n.link ?? null,
          agentId: n.agentId ?? null,
          read: false,
          createdAt: nowIso(),
        };
        await this.repos.notifications.create(item);
        sent++;
      } catch (err) {
        console.error('[notifications]', (err as Error).message);
      }
    }
    return sent;
  }

  async list(user: AppUser) {
    const items = await this.repos.notifications.listForUser(user.uid, 50);
    return { items, unread: items.filter((n) => !n.read).length };
  }

  async read(user: AppUser, id: string) {
    const n = await this.repos.notifications.get(id);
    if (!n || n.userId !== user.uid) throw notFound('Notification not found');
    await this.repos.notifications.markRead(id);
  }

  readAll(user: AppUser) {
    return this.repos.notifications.markAllRead(user.uid);
  }
}
