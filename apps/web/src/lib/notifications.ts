import { computed, ref } from 'vue';
import type { AppNotification, NotificationPrefs } from '@widebed/shared';
import { api } from './api';

/**
 * The bell's data, shared by every bell on screen. Polls the API quietly every 30 s
 * (and when the tab comes back). New notices can also pop up as browser notifications
 * if the person switched that on in Settings and the browser allows it.
 */
const items = ref<AppNotification[]>([]);
const unread = ref(0);
const prefs = ref<NotificationPrefs | null>(null);
const seen = new Set<string>();
let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let first = true;

async function refresh() {
  try {
    const res = await api<{ items: AppNotification[]; unread: number }>('/notifications', { quiet: true });
    const fresh = res.items.filter((n) => !n.read && !seen.has(n.notificationId));
    res.items.forEach((n) => seen.add(n.notificationId));
    items.value = res.items;
    unread.value = res.unread;
    if (!first) popUp(fresh);
    first = false;
  } catch {
    /* offline or signed out: try again next time */
  }
}

function popUp(list: AppNotification[]) {
  if (!list.length || !prefs.value?.browser || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  for (const n of list.slice(0, 3)) {
    try {
      const pop = new Notification(n.title, { body: n.body, icon: '/favicon.svg', tag: n.notificationId });
      pop.onclick = () => {
        window.focus();
        if (n.link) window.location.assign(n.link);
      };
    } catch {
      /* some browsers only allow this from a service worker */
    }
  }
}

export function useNotifications() {
  if (!started && typeof window !== 'undefined') {
    started = true;
    api<NotificationPrefs>('/notifications/prefs', { quiet: true })
      .then((p) => (prefs.value = p))
      .catch(() => undefined);
    refresh();
    timer = setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
  }
  return {
    items,
    unread,
    prefs,
    hasUnread: computed(() => unread.value > 0),
    refresh,
    async read(n: AppNotification) {
      if (n.read) return;
      n.read = true;
      unread.value = Math.max(0, unread.value - 1);
      await api(`/notifications/${n.notificationId}/read`, { method: 'POST', quiet: true }).catch(() => undefined);
    },
    async readAll() {
      items.value.forEach((n) => (n.read = true));
      unread.value = 0;
      await api('/notifications/read-all', { method: 'POST', quiet: true }).catch(() => undefined);
    },
    async savePrefs(p: NotificationPrefs) {
      prefs.value = await api<NotificationPrefs>('/notifications/prefs', { method: 'PUT', body: p });
      return prefs.value;
    },
  };
}

/** Stop polling (sign-out). */
export function stopNotifications() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
  first = true;
  items.value = [];
  unread.value = 0;
  seen.clear();
}
