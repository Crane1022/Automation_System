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
  Sun,
  Users,
  Workflow,
  History,
  Construction,
} from '@lucide/vue';
import { useAuthStore } from '@/stores/auth';
import { useTheme } from '@/lib/theme';
import { roleLabels } from '@/lib/format';
import NotificationBell from '@/components/NotificationBell.vue';
import UnderConstruction from '@/components/ui/UnderConstruction.vue';
import Modal from '@/components/ui/Modal.vue';
import { stopNotifications } from '@/lib/notifications';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const { isDark, toggle } = useTheme();
const mobileOpen = ref(false);
const aiTeamOpen = ref(false);

interface NavItem { to: string; label: string; icon: unknown; phase?: number }
interface NavGroup { key: string; label: string; items: NavItem[] }

/** The menu, grouped by area. Every group is always shown. */
const groups = computed<NavGroup[]>(() =>
  [
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
/** Active item: lighter navy with a blue bar on the left. */
const itemClass = (to: string) => [
  'relative flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[13px] transition-[background-color,color,transform] duration-150 active:scale-[0.98]',
  isActive(to)
    ? 'bg-[var(--wb-nav-active)] text-[var(--wb-nav-ink)] font-medium before:absolute before:left-0 before:inset-y-1 before:w-[3px] before:rounded-full before:bg-[var(--wb-nav-accent)]'
    : 'text-muted hover:bg-surface-2 hover:text-ink',
];
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
      class="wb-nav fixed inset-y-0 left-0 z-40 w-[232px] border-r border-line flex flex-col transition-transform lg:static lg:translate-x-0"
      :class="mobileOpen ? 'translate-x-0' : '-translate-x-full'"
    >
      <div class="h-14 flex items-center gap-2.5 px-4 border-b border-line">
        <img src="/favicon.svg" alt="" class="size-7" />
        <div class="leading-tight flex-1">
          <div class="text-[13.5px] font-semibold">Widebed</div>
          <div class="text-[11px] text-subtle">Automation</div>
        </div>
        <NotificationBell class="hidden lg:block" placement="sidebar" />
      </div>
      <nav class="flex-1 overflow-y-auto p-2">
        <div class="h-6 px-2.5 flex items-center text-[11px] text-subtle">Overview</div>
        <RouterLink to="/" :class="itemClass('/')" @click="mobileOpen = false">
          <LayoutDashboard class="size-4 shrink-0" /><span class="flex-1 truncate">Dashboard</span>
        </RouterLink>
        <div v-for="g in groups" :key="g.key" class="mt-4">
          <div class="h-6 px-2.5 flex items-center text-[11px] text-subtle">{{ g.label }}</div>
          <div class="space-y-0.5">
            <RouterLink v-for="item in g.items" :key="item.to" :to="item.to" :class="itemClass(item.to)" @click="mobileOpen = false">
              <component :is="item.icon" class="size-4 shrink-0" />
              <span class="flex-1 truncate">{{ item.label }}</span>
              <span v-if="item.phase" class="text-[10px] text-subtle">P{{ item.phase }}</span>
            </RouterLink>
          </div>
        </div>
        <!-- AI Team: only the title. Its pages are hidden until they are ready. -->
        <button
          class="mt-4 w-full h-8 px-2.5 flex items-center gap-2 rounded-md text-[11px] text-subtle hover:bg-surface-2 hover:text-muted transition-colors"
          title="Under construction — do not use"
          data-no-loading
          @click="aiTeamOpen = true"
        >
          <span class="flex-1 text-left">AI Team</span>
          <span class="inline-flex items-center gap-1 h-4 px-1.5 rounded bg-[#3a2a0c] text-[#f2b84b] text-[10px] font-medium"><Construction class="size-3" />Soon</span>
        </button>
      </nav>
      <div class="p-3 border-t border-line">
        <div class="flex items-center gap-2.5">
          <div class="size-8 rounded-full bg-[var(--wb-nav-active)] text-[var(--wb-nav-accent)] grid place-items-center text-[12px] font-semibold">{{ initials }}</div>
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
    <Modal v-if="aiTeamOpen" title="AI Team" width="860px" @close="aiTeamOpen = false">
      <UnderConstruction />
      <template #footer><button class="btn-primary" data-no-loading @click="aiTeamOpen = false">Got it</button></template>
    </Modal>
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
            <div v-if="r.meta.underConstruction" :key="'uc-' + r.path" class="max-w-4xl mx-auto p-6"><div class="card p-5 overflow-hidden"><UnderConstruction /></div></div>
            <component :is="Component" v-else :key="r.matched[r.matched.length - 1]?.path" />
          </Transition>
        </RouterView>
      </main>
    </div>
  </div>
</template>
