<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Activity,
  Bot,
  CalendarClock,
  KeyRound,
  LayoutDashboard,
  LayoutTemplate,
  LogOut,
  Menu,
  Moon,
  Plug,
  Settings,
  Sparkles,
  Sun,
  Users,
  Workflow,
  History,
  ListTodo,
  ShieldCheck,
  Network,
  BookOpen,
  TrendingUp,
  ChevronDown,
} from '@lucide/vue';
import { useAuthStore } from '@/stores/auth';
import { useTheme } from '@/lib/theme';
import { roleLabels } from '@/lib/format';
import NotificationBell from '@/components/NotificationBell.vue';
import { stopNotifications } from '@/lib/notifications';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const { isDark, toggle } = useTheme();
const mobileOpen = ref(false);

interface NavItem { to: string; label: string; icon: unknown; phase?: number }
interface NavGroup { key: string; label: string; items: NavItem[] }

/** The menu, grouped so it stays short. Groups fold open/closed; the one you are in is always open. */
const groups = computed<NavGroup[]>(() =>
  [
    // AI Team - HIDDEN
    // {
    //   key: 'ai',
    //   label: 'AI Team',
    //   items: [
    //     { to: '/ai-staff', label: 'AI Staff', icon: Sparkles },
    //     { to: '/ai-tasks', label: 'AI Tasks', icon: ListTodo },
    //     { to: '/ai-schedules', label: 'AI Schedules', icon: CalendarClock },
    //     { to: '/ai-approvals', label: 'Approvals', icon: ShieldCheck },
    //     { to: '/ai-collaboration', label: 'Collaboration', icon: Network },
    //     { to: '/knowledge', label: 'Company Knowledge', icon: BookOpen },
    //     ...(auth.can('agent.manage') || auth.can('audit.view') || auth.profile?.role === 'department_manager' ? [{ to: '/ai-performance', label: 'AI Performance', icon: TrendingUp }] : []),
    //   ],
    // },
    {
      key: 'automation',
      label: 'Automation',
      items: [
        { to: '/workflows', label: 'Workflows', icon: Workflow },
        { to: '/executions', label: 'Executions', icon: Activity },
        { to: '/schedules', label: 'Schedules', icon: CalendarClock },
        { to: '/templates', label: 'Templates', icon: LayoutTemplate },
      ],
    },
    {
      key: 'connections',
      label: 'Connections',
      items: [
        { to: '/integrations', label: 'Integrations', icon: Plug },
        { to: '/credentials', label: 'Credentials', icon: KeyRound },
        { to: '/ai-agents', label: 'AI Settings', icon: Bot },
      ],
    },
    {
      key: 'admin',
      label: 'Admin',
      items: [
        ...(auth.can('user.manage') ? [{ to: '/users', label: 'Users & Permissions', icon: Users }] : []),
        ...(auth.can('audit.view') ? [{ to: '/activity', label: 'Activity log', icon: History }] : []),
        { to: '/settings', label: 'Settings', icon: Settings },
      ],
    },
  ].filter((g) => g.items.length),
);

/**
 * Accordion: one group open at a time. Opening a group closes the others; clicking the open
 * group closes it. Moving to a page opens that page's group. Remembered in this browser.
 */
const OPEN_KEY = 'wb.nav.open';
const openKey = ref<string | null>((() => {
  try {
    return localStorage.getItem(OPEN_KEY);
  } catch {
    return null;
  }
})());
const groupActive = (g: NavGroup) => g.items.some((i) => isActive(i.to));
const isOpen = (g: NavGroup) => openKey.value === g.key;
function remember() {
  try {
    if (openKey.value) localStorage.setItem(OPEN_KEY, openKey.value);
    else localStorage.removeItem(OPEN_KEY);
  } catch {
    /* private mode: just don't remember */
  }
}
function toggleGroup(g: NavGroup) {
  openKey.value = openKey.value === g.key ? null : g.key;
  remember();
}

const isActive = (to: string) => (to === '/' ? route.path === '/' : route.path.startsWith(to));
/** Moving to a page opens that page's group (runs after isActive exists). */
watch(
  () => route.path,
  () => {
    const g = groups.value.find(groupActive);
    if (g && openKey.value !== g.key) {
      openKey.value = g.key;
      remember();
    }
  },
  { immediate: true },
);
const initials = computed(() =>
  (auth.profile?.name ?? '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase(),
);

async function logout() {
  stopNotifications();
  await auth.logout();
  router.push('/login');
}
</script>

<template>
  <div class="h-full flex">
    <!-- Sidebar -->
    <aside
      class="fixed inset-y-0 left-0 z-40 w-[232px] bg-surface border-r border-line flex flex-col transition-transform lg:static lg:translate-x-0"
      :class="mobileOpen ? 'translate-x-0' : '-translate-x-full'"
    >
      <div class="h-14 flex items-center gap-2.5 px-4 border-b border-line">
        <img src="/favicon.svg" alt="" class="size-7" />
        <div class="leading-tight flex-1">
          <div class="text-[13px] font-semibold">Widebed</div>
          <div class="text-[11px] text-subtle">Automation</div>
        </div>
        <NotificationBell class="hidden lg:block" placement="sidebar" />
      </div>
      <nav class="flex-1 overflow-y-auto p-2">
        <RouterLink
          to="/"
          class="flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[13px] transition-[background-color,color,transform] duration-150 active:scale-[0.98]"
          :class="isActive('/') ? 'bg-brand-soft text-brand font-medium' : 'text-muted hover:bg-surface-2 hover:text-ink'"
          @click="mobileOpen = false"
        >
          <LayoutDashboard class="size-4 shrink-0" /><span class="flex-1 truncate">Overview</span>
        </RouterLink>
        <div v-for="g in groups" :key="g.key" class="mt-3">
          <button
            class="w-full flex items-center gap-1 h-6 px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-subtle hover:text-muted rounded"
            :class="groupActive(g) && !isOpen(g) ? 'text-brand' : ''"
            :aria-expanded="isOpen(g)"
            data-no-loading
            @click="toggleGroup(g)"
          >
            <span class="flex-1 text-left">{{ g.label }}</span>
            <span v-if="groupActive(g) && !isOpen(g)" class="size-1.5 rounded-full bg-brand mr-1" aria-hidden="true" />
            <ChevronDown class="size-3 transition-transform duration-300 ease-out" :class="isOpen(g) ? '' : '-rotate-90'" />
          </button>
          <div class="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(.2,.8,.2,1)]" :style="{ gridTemplateRows: isOpen(g) ? '1fr' : '0fr' }">
            <div class="overflow-hidden space-y-0.5 pt-0.5 transition-opacity duration-300" :class="isOpen(g) ? 'opacity-100' : 'opacity-0'">
              <RouterLink
                v-for="item in g.items"
                :key="item.to"
                :to="item.to"
                class="flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[13px] transition-[background-color,color,transform] duration-150 active:scale-[0.98]"
                :class="isActive(item.to) ? 'bg-brand-soft text-brand font-medium' : 'text-muted hover:bg-surface-2 hover:text-ink'"
                :tabindex="isOpen(g) ? 0 : -1"
                @click="mobileOpen = false"
              >
                <component :is="item.icon" class="size-4 shrink-0" />
                <span class="flex-1 truncate">{{ item.label }}</span>
                <span v-if="item.phase" class="text-[10px] text-subtle">P{{ item.phase }}</span>
              </RouterLink>
            </div>
          </div>
        </div>
      </nav>
      <div class="p-3 border-t border-line">
        <div class="flex items-center gap-2.5">
          <div class="size-8 rounded-full bg-moss-soft text-moss grid place-items-center text-[12px] font-semibold">{{ initials }}</div>
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-medium truncate">{{ auth.profile?.name }}</div>
            <div class="text-[11px] text-subtle truncate">{{ roleLabels[auth.profile?.role ?? ''] }}<template v-if="auth.profile?.department"> · {{ auth.profile.department }}</template></div>
          </div>
          <button class="btn-ghost btn-icon" :title="isDark ? 'Light mode' : 'Dark mode'" @click="toggle">
            <Sun v-if="isDark" class="size-4" /><Moon v-else class="size-4" />
          </button>
          <button class="btn-ghost btn-icon" title="Sign out" @click="logout"><LogOut class="size-4" /></button>
        </div>
      </div>
    </aside>
    <div v-if="mobileOpen" class="fixed inset-0 z-30 bg-black/30 lg:hidden" @click="mobileOpen = false" />

    <!-- Main -->
    <div class="flex-1 min-w-0 flex flex-col">
      <header class="lg:hidden h-12 flex items-center gap-2 px-3 border-b border-line bg-surface">
        <button class="btn-ghost btn-icon" aria-label="Open menu" @click="mobileOpen = true"><Menu class="size-4" /></button>
        <span class="text-[13px] font-semibold flex-1">{{ route.meta.title }}</span>
        <NotificationBell placement="header" />
      </header>
      <main class="flex-1 overflow-y-auto">
        <!-- Pages slide in gently. Keyed by the page (not its id), so switching Assistant chats doesn't reload the page. -->
        <RouterView v-slot="{ Component, route: r }">
          <Transition name="page" mode="out-in">
            <component :is="Component" :key="r.matched[r.matched.length - 1]?.path" />
          </Transition>
        </RouterView>
      </main>
    </div>
  </div>
</template>
