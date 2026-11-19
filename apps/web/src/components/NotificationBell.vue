<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { AlertTriangle, Bell, CheckCheck, CircleCheck, CircleX, Settings, ShieldCheck, ShieldQuestion, Sparkles } from '@lucide/vue';
import type { AppNotification } from '@widebed/shared';
import { useNotifications } from '@/lib/notifications';
import { timeAgo } from '@/lib/format';

/** The bell: what your AI staff finished, what failed, and problems they found. */
const props = withDefaults(defineProps<{ placement?: 'sidebar' | 'header' }>(), { placement: 'sidebar' });
const router = useRouter();
const { items, unread, read, readAll, refresh } = useNotifications();
const open = ref(false);
const root = ref<HTMLElement | null>(null);

function toggle() {
  open.value = !open.value;
  if (open.value) refresh();
}
function onDoc(e: MouseEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener('click', onDoc));
onBeforeUnmount(() => document.removeEventListener('click', onDoc));

async function go(n: AppNotification) {
  open.value = false;
  await read(n);
  if (n.link) router.push(n.link);
}
const ICON = { 'task.completed': CircleCheck, 'task.failed': CircleX, 'issue.new': AlertTriangle, 'followup.created': Sparkles, 'approval.needed': ShieldQuestion, 'approval.decided': ShieldCheck } as const;
const TONE = { 'task.completed': 'text-ok', 'task.failed': 'text-bad', 'issue.new': 'text-warn', 'followup.created': 'text-info', 'approval.needed': 'text-warn', 'approval.decided': 'text-info' } as const;
</script>

<template>
  <div ref="root" class="relative">
    <button class="relative" :class="props.placement === 'sidebar' ? 'size-8 grid place-items-center rounded-md text-side-text hover:bg-side-hover hover:text-side-ink transition-colors' : 'btn-ghost btn-icon'" :aria-label="unread ? `${unread} new notifications` : 'Notifications'" data-no-loading @click.stop="toggle">
      <Bell class="size-4" :class="{ 'wb-ring': unread }" />
      <Transition name="pop">
        <span v-if="unread" class="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-bad text-white text-[10px] font-semibold grid place-items-center tabular-nums">{{ unread > 9 ? '9+' : unread }}</span>
      </Transition>
    </button>
    <Transition name="pop">
      <div
        v-if="open"
        class="z-50 w-[min(360px,calc(100vw-16px))] card shadow-[var(--shadow-pop)] overflow-hidden"
        :class="props.placement === 'sidebar' ? 'fixed left-2 lg:left-[240px] top-2' : 'fixed right-2 top-14'"
        @click.stop
      >
        <div class="flex items-center justify-between px-4 h-11 border-b border-line">
          <span class="font-semibold text-[13.5px]">Notifications</span>
          <div class="flex items-center gap-1">
            <button v-if="unread" class="btn-ghost h-7 px-2 text-[12px]" data-no-loading @click="readAll"><CheckCheck class="size-3.5" />Mark all read</button>
            <RouterLink to="/settings" class="btn-ghost btn-icon size-7" title="Notification settings" @click="open = false"><Settings class="size-3.5" /></RouterLink>
          </div>
        </div>
        <ul class="max-h-[420px] overflow-y-auto divide-y divide-line">
          <li v-if="!items.length" class="px-4 py-8 text-center text-[13px] text-subtle">Nothing yet. When your AI staff finish work or find a problem, it shows here.</li>
          <li v-for="(n, i) in items" :key="n.notificationId" class="animate-in" :style="{ '--i': Math.min(i, 8) }">
            <button class="w-full flex gap-3 px-4 py-3 text-left hover:bg-surface-2 transition-colors" :class="n.read ? '' : 'bg-brand-soft/30'" @click="go(n)">
              <component :is="ICON[n.kind]" class="size-4 mt-0.5 shrink-0" :class="TONE[n.kind]" />
              <span class="min-w-0 flex-1">
                <span class="block text-[13px]" :class="n.read ? 'text-muted' : 'font-medium'">{{ n.title }}</span>
                <span class="block text-[12px] text-subtle line-clamp-2">{{ n.body }}</span>
                <span class="block text-[11px] text-subtle mt-0.5">{{ timeAgo(n.createdAt) }}</span>
              </span>
              <span v-if="!n.read" class="size-2 rounded-full bg-brand mt-1.5 shrink-0" />
            </button>
          </li>
        </ul>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* A small swing when something new arrives */
.wb-ring { animation: wb-ring 2.4s ease-in-out 1; transform-origin: top center; }
@keyframes wb-ring { 0%, 60%, 100% { transform: rotate(0); } 10% { transform: rotate(14deg); } 20% { transform: rotate(-12deg); } 30% { transform: rotate(8deg); } 40% { transform: rotate(-5deg); } }
@media (prefers-reduced-motion: reduce) { .wb-ring { animation: none; } }
</style>
