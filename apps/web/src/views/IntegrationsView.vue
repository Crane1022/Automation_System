<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { Bot, CheckCircle2, Circle, Database, GlobeLock, Mail, Radio, Sheet, Webhook, Wrench, type LucideIcon } from '@lucide/vue';
import type { Credential, CredentialProvider } from '@widebed/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { useAuthStore } from '@/stores/auth';
import { useCredentialsStore } from '@/stores/credentials';
import { toastError } from '@/lib/toast';

/**
 * Integration Hub: every outside service in one place, in plain words.
 * Connections themselves are managed on the Credentials page; "Connect" opens the right form there.
 */
const auth = useAuthStore();
const store = useCredentialsStore();
const router = useRouter();
const canManage = computed(() => auth.can('credential.manage'));
onMounted(() => store.load(true).catch(toastError));

interface Card {
  key: string;
  name: string;
  icon: LucideIcon;
  tint: string;
  what: string;
  examples: string[];
  provider?: CredentialProvider;
  /** Only connections matching this (e.g. one AI service). */
  match?: (c: Credential) => boolean;
  /** Query value for /credentials?add=… */
  add?: string;
  /** Needs no connection at all. */
  builtIn?: string;
  /** Server-side setup missing (shown to IT). */
  setupNeeded?: () => string | null;
}

const googleSetup = () => (store.google.configured ? null : 'IT setup needed first: Google sign-in is not configured on the server (see README → Gmail).');
const cards: Card[] = [
  { key: 'gmail', name: 'Gmail', icon: Mail, tint: 'bg-[#fdecea] text-[#c5221f] dark:bg-[#3a2120] dark:text-[#f28b82]', what: 'Send emails and read incoming ones from a Google mailbox.', examples: ['Rent and check-in reminders', 'Alert a team about a new booking'], provider: 'google_oauth', add: 'google', setupNeeded: googleSetup },
  { key: 'sheets', name: 'Google Sheets', icon: Sheet, tint: 'bg-[#e6f4ea] text-[#137333] dark:bg-[#1e3326] dark:text-[#81c995]', what: 'Read rows, add rows and update rows in your Google Sheets. Uses the same Google account as Gmail.', examples: ['Tenant list → monthly reminders', 'Log every booking'], provider: 'google_oauth', add: 'google', setupNeeded: googleSetup },
  { key: 'firebase', name: 'Widebed PMS / TMS data', icon: Database, tint: 'bg-[#fef7e0] text-[#b06000] dark:bg-[#3a3020] dark:text-[#fdd663]', what: 'Read (and, if allowed, change) data in another Firebase project — only the collections you choose.', examples: ['Look up a booking by ID', 'Update a task status'], provider: 'firebase_service_account', add: 'firebase' },
  { key: 'events', name: 'PMS / TMS events', icon: Radio, tint: 'bg-[#e8f0fe] text-[#1967d2] dark:bg-[#1f2b3d] dark:text-[#8ab4f8]', what: 'Let Widebed PMS or TMS start workflows by sending events like “booking.created”.', examples: ['New booking → tell housekeeping'], provider: 'event_source', add: 'event' },
  { key: 'openai', name: 'OpenAI (ChatGPT)', icon: Bot, tint: 'bg-[#efe8f5] text-[#6c4a8f] dark:bg-[#2a2233] dark:text-[#b99ad6]', what: 'AI that writes, sorts and reads text in your workflows.', examples: ['Draft replies to guests', 'Read booking emails'], provider: 'ai_provider', match: (c) => c.details.aiService === 'openai', add: 'openai' },
  { key: 'anthropic', name: 'Anthropic (Claude)', icon: Bot, tint: 'bg-[#efe8f5] text-[#6c4a8f] dark:bg-[#2a2233] dark:text-[#b99ad6]', what: 'AI that writes, sorts and reads text in your workflows.', examples: ['Sort guest emails', 'Summarise complaints'], provider: 'ai_provider', match: (c) => c.details.aiService === 'anthropic', add: 'anthropic' },
  { key: 'gemini', name: 'Google Gemini', icon: Bot, tint: 'bg-[#efe8f5] text-[#6c4a8f] dark:bg-[#2a2233] dark:text-[#b99ad6]', what: 'AI that writes, sorts and reads text in your workflows.', examples: ['Translate guest messages', 'Pull details out of emails'], provider: 'ai_provider', match: (c) => c.details.aiService === 'gemini', add: 'gemini' },
  { key: 'websites', name: 'Websites (Assistant browser)', icon: GlobeLock, tint: 'bg-surface-2 text-muted', what: 'Saved logins the Assistant’s browser may use, e.g. myTNB. Passwords are encrypted and never shown to the AI.', examples: ['Collect TNB bills', 'Check a supplier portal'], provider: 'website_login', add: 'website' },
  { key: 'webhook', name: 'Webhooks', icon: Webhook, tint: 'bg-surface-2 text-muted', what: 'Any system that can call a web address can start a workflow — website forms, payment systems…', examples: ['Website enquiry → sheet + email', 'Payment received → mark as paid'], builtIn: 'Built in — no connection needed. Add a Webhook Trigger to a workflow.' },
];

const connections = (card: Card) => (card.provider ? store.byProvider(card.provider).filter((c) => !card.match || card.match(c)) : []);
const connectedCount = computed(() => cards.filter((c) => !c.builtIn && connections(c).some((x) => x.status === 'connected')).length);
function connect(card: Card) {
  router.push({ path: '/credentials', query: { add: card.add } });
}
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1280px] mx-auto">
    <PageHeader title="Integrations" :subtitle="`The outside services your workflows can use. ${connectedCount} of ${cards.length - 1} connected.`" />

    <div class="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
      <div v-for="(card, idx) in cards" :key="card.key" class="animate-in card p-4 flex flex-col gap-3" :style="{ '--i': idx }">
        <div class="flex items-center gap-3">
          <span class="size-10 rounded-lg grid place-items-center shrink-0" :class="card.tint"><component :is="card.icon" class="size-5" /></span>
          <div class="min-w-0">
            <div class="font-semibold text-[14px] truncate">{{ card.name }}</div>
            <div v-if="card.builtIn" class="text-[12px] text-ok flex items-center gap-1"><CheckCircle2 class="size-3.5" />Always available</div>
            <div v-else-if="connections(card).length" class="text-[12px] text-ok flex items-center gap-1"><CheckCircle2 class="size-3.5" />{{ connections(card).length }} connected</div>
            <div v-else class="text-[12px] text-subtle flex items-center gap-1"><Circle class="size-3.5" />Not connected</div>
          </div>
        </div>

        <p class="text-[13px] text-muted leading-relaxed">{{ card.what }}</p>
        <ul class="text-[12px] text-subtle space-y-0.5">
          <li v-for="e in card.examples" :key="e">• {{ e }}</li>
        </ul>

        <ul v-if="connections(card).length" class="space-y-1">
          <li v-for="c in connections(card)" :key="c.credentialId" class="flex items-center gap-2 text-[12px] rounded-md bg-surface-2 px-2 py-1.5">
            <span class="truncate flex-1">{{ c.name }}<span v-if="c.details.accountEmail" class="text-subtle"> · {{ c.details.accountEmail }}</span></span>
            <StatusBadge :status="c.status === 'connected' ? 'active' : c.status === 'error' ? 'failed' : 'pending'" />
          </li>
        </ul>

        <div class="mt-auto pt-1">
          <p v-if="card.builtIn" class="text-[12px] text-subtle">{{ card.builtIn }}</p>
          <template v-else-if="canManage">
            <p v-if="card.setupNeeded?.()" class="text-[12px] text-warn mb-2 flex gap-1.5"><Wrench class="size-3.5 shrink-0 mt-0.5" />{{ card.setupNeeded?.() }}</p>
            <div class="flex gap-2">
              <button class="btn-primary h-8 flex-1" :disabled="!!card.setupNeeded?.()" @click="connect(card)">{{ connections(card).length ? 'Add another' : 'Connect' }}</button>
              <RouterLink v-if="connections(card).length" to="/credentials" class="btn-secondary h-8">Manage</RouterLink>
            </div>
          </template>
          <p v-else-if="!connections(card).length" class="text-[12px] text-subtle">Ask an IT Admin to connect it.</p>
        </div>
      </div>
    </div>

    <p class="text-[12px] text-subtle mt-6">
      Passwords and keys are encrypted on the server and never shown again. Every connection can be limited to one department on the Credentials page.
    </p>
  </div>
</template>
