<script setup lang="ts">
import { computed, ref } from 'vue';
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

const isActive = (to: string) => (to === '/' ? route.path === '/' : route.path.startsWith(to));
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
      class="fixed inset-y-0 left-0 z-40 w-[232px] bg-side text-side-text border-r border-side-line flex flex-col transition-transform lg:static lg:translate-x-0"
      :class="mobileOpen ? 'translate-x-0' : '-translate-x-full'"
    >
      <div class="h-14 flex items-center gap-2.5 px-4 border-b border-side-line">
        <img src="/favicon.svg" alt="" class="size-7" />
        <div class="leading-tight flex-1">
          <div class="text-[13px] font-semibold text-side-ink">Widebed</div>
          <div class="text-[11px] text-side-subtle">Automation</div>
        </div>
        <NotificationBell class="hidden lg:block" placement="sidebar" />
      </div>
      <nav class="flex-1 overflow-y-auto p-2">
        <RouterLink
          to="/"
          class="flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[13px] transition-[background-color,color,transform] duration-150 active:scale-[0.98]"
          :class="isActive('/') ? 'bg-side-active text-side-ink font-medium' : 'text-side-text hover:bg-side-hover hover:text-side-ink'"
          @click="mobileOpen = false"
        >
          <LayoutDashboard class="size-4 shrink-0" /><span class="flex-1 truncate">Overview</span>
        </RouterLink>
        <div v-for="g in groups" :key="g.key" class="mt-4">
          <div class="h-6 px-2.5 flex items-center text-[10.5px] font-semibold uppercase tracking-[0.08em] text-side-subtle">{{ g.label }}</div>
          <div class="space-y-0.5 pt-0.5">
            <RouterLink
              v-for="item in g.items"
              :key="item.to"
              :to="item.to"
              class="relative flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[13px] transition-[background-color,color,transform] duration-150 active:scale-[0.98]"
              :class="isActive(item.to) ? 'bg-side-active text-side-ink font-medium' : 'text-side-text hover:bg-side-hover hover:text-side-ink'"
              @click="mobileOpen = false"
            >
              <span v-if="isActive(item.to)" class="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-side-accent" aria-hidden="true" />
              <component :is="item.icon" class="size-4 shrink-0" />
              <span class="flex-1 truncate">{{ item.label }}</span>
            </RouterLink>
          </div>
        </div>
      </nav>
      <div class="p-3 border-t border-side-line">
        <div class="flex items-center gap-2.5">
          <div class="size-8 rounded-full bg-side-active text-side-ink grid place-items-center text-[12px] font-semibold">{{ initials }}</div>
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-medium truncate text-side-ink">{{ auth.profile?.name }}</div>
            <div class="text-[11px] text-side-subtle truncate">{{ roleLabels[auth.profile?.role ?? ''] }}<template v-if="auth.profile?.department"> · {{ auth.profile.department }}</template></div>
          </div>
          <button class="size-8 grid place-items-center rounded-md text-side-text hover:bg-side-hover hover:text-side-ink" :title="isDark ? 'Light mode' : 'Dark mode'" @click="toggle">
            <Sun v-if="isDark" class="size-4" /><Moon v-else class="size-4" />
          </button>
          <button class="size-8 grid place-items-center rounded-md text-side-text hover:bg-side-hover hover:text-side-ink" title="Sign out" @click="logout"><LogOut class="size-4" /></button>
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
