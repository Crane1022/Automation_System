<script setup lang="ts">
import PageHeader from '@/components/ui/PageHeader.vue';
import { computed, onMounted, ref } from 'vue';
import { BellRing, Download, Moon, Send, Sun, Upload, X } from '@lucide/vue';
import { BACKUP_FORMAT, type Credential, type SystemSettings } from '@widebed/shared';
import { useAuthStore } from '@/stores/auth';
import { useTheme } from '@/lib/theme';
import { roleLabels } from '@/lib/format';
import { api } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';
import { downloadJson } from '@/lib/download';
import { useNotifications } from '@/lib/notifications';
import type { NotificationPrefs } from '@widebed/shared';

const auth = useAuthStore();
const { isDark, toggle } = useTheme();
const isAdmin = computed(() => auth.can('settings.manage'));

/* ---------------- Notifications (everyone) ---------------- */
const notif = useNotifications();
const browserState = ref(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
async function setPref(key: keyof NotificationPrefs, value: boolean) {
  if (!notif.prefs.value) return;
  const next = { ...notif.prefs.value, [key]: value };
  if (key === 'browser' && value && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
    browserState.value = await Notification.requestPermission();
    if (browserState.value !== 'granted') {
      toast('Your browser blocked notifications. Allow them in the browser’s site settings (the padlock next to the address).', 'error');
      return;
    }
  }
  try {
    await notif.savePrefs(next);
  } catch (err) {
    toastError(err);
  }
}

/* ---------------- Failure alerts ---------------- */
const sys = ref<SystemSettings | null>(null);
const googleAccounts = ref<Credential[]>([]);
const newEmail = ref('');
const saving = ref(false);
const testing = ref(false);

onMounted(async () => {
  if (!isAdmin.value) return;
  try {
    const [s, c] = await Promise.all([api<SystemSettings>('/system/settings'), api<{ items: Credential[] }>('/credentials')]);
    sys.value = s;
    googleAccounts.value = c.items.filter((x) => x.provider === 'google_oauth');
  } catch (err) {
    toastError(err);
  }
});

function addEmail() {
  const e = newEmail.value.trim().replace(/[,;]$/, '');
  if (!e || !sys.value) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return toast(`“${e}” doesn’t look like an email address`, 'error');
  if (!sys.value.alerts.emails.includes(e)) sys.value.alerts.emails.push(e);
  newEmail.value = '';
}
async function saveAlerts() {
  if (!sys.value) return;
  addEmail();
  saving.value = true;
  try {
    sys.value = await api<SystemSettings>('/system/settings', { method: 'PUT', body: sys.value });
    toast(sys.value.alerts.enabled ? 'Saved. Failure alerts are on.' : 'Saved. Failure alerts are off.', 'success');
  } catch (err) {
    toastError(err);
  } finally {
    saving.value = false;
  }
}
async function testAlert() {
  if (!sys.value) return;
  addEmail();
  testing.value = true;
  try {
    // Save first so the test uses what's on screen.
    const draft = { ...sys.value, alerts: { ...sys.value.alerts, enabled: sys.value.alerts.enabled && !!sys.value.alerts.credentialId } };
    sys.value = await api<SystemSettings>('/system/settings', { method: 'PUT', body: draft });
    await api('/system/alerts/test', { method: 'POST' });
    toast(`Test email sent to ${sys.value.alerts.emails.join(', ')}`, 'success');
  } catch (err) {
    toastError(err);
  } finally {
    testing.value = false;
  }
}

/* ---------------- Code steps: who may write code ---------------- */
const savingCode = ref(false);
async function saveCodeAccess(who: 'it_admin' | 'editors') {
  if (!sys.value) return;
  if (who === 'editors' && !confirm('Let everyone who builds workflows add and change Code steps?\n\nCode runs in a locked sandbox (no internet, no files, time and memory limits), but it can still do anything with the data a workflow has. Turn this on only if you trust your workflow builders.')) return;
  savingCode.value = true;
  try {
    sys.value = await api<SystemSettings>('/system/settings', { method: 'PUT', body: { ...sys.value, code: { whoCanWrite: who } } });
    toast(who === 'editors' ? 'Workflow builders can now write Code steps.' : 'Only IT Admins can write Code steps.', 'success');
    auth.loadProfile();
  } catch (err) {
    toastError(err);
  } finally {
    savingCode.value = false;
  }
}

/* ---------------- Backup & restore ---------------- */
const restoring = ref<{ done: number; total: number; failed: string[] } | null>(null);
async function downloadBackup() {
  try {
    const file = await api<{ workflows: unknown[] }>('/system/backup');
    downloadJson(file, `widebed-backup-${new Date().toISOString().slice(0, 10)}.json`);
    toast(`Backup downloaded (${file.workflows.length} workflows)`, 'success');
  } catch (err) {
    toastError(err);
  }
}
async function restore(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  let data: any;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast('That file isn’t a backup (it can’t be read).', 'error');
  }
  if (data?.format !== BACKUP_FORMAT || !Array.isArray(data.workflows)) return toast('That file isn’t a Widebed backup. Use “Import” on the Workflows page for single workflows.', 'error');
  if (!confirm(`Add ${data.workflows.length} workflows from this backup?\n\nThey are added as new, switched-off copies. Nothing you have now is changed.`)) return;
  restoring.value = { done: 0, total: data.workflows.length, failed: [] };
  for (const w of data.workflows) {
    try {
      await api('/workflows/import', { method: 'POST', body: { file: w, department: w.backup?.department ?? null, autoConnect: true }, quiet: true });
    } catch {
      restoring.value.failed.push(w?.workflow?.name ?? 'Unnamed');
    }
    restoring.value.done++;
  }
  const ok = restoring.value.total - restoring.value.failed.length;
  toast(`Restored ${ok} of ${restoring.value.total} workflows. Open each one to pick its connections, then publish.`, restoring.value.failed.length ? 'error' : 'success');
}
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[880px] mx-auto space-y-4">
    <PageHeader title="Settings" subtitle="Your profile and how the app looks." />

    <section class="card p-5">
      <h2 class="section-title mb-3">Your profile</h2>
      <dl class="grid grid-cols-[140px_minmax(0,1fr)] gap-y-2 text-[13px]">
        <dt class="text-muted">Name</dt><dd>{{ auth.profile?.name }}</dd>
        <dt class="text-muted">Email</dt><dd>{{ auth.profile?.email }}</dd>
        <dt class="text-muted">Role</dt><dd>{{ roleLabels[auth.profile?.role ?? ''] }}</dd>
        <dt class="text-muted">Department</dt><dd>{{ auth.profile?.department ?? '—' }}</dd>
      </dl>
      <p class="text-[12px] text-subtle mt-3">Role and department are managed by a Super Admin.</p>
    </section>

    <section class="card p-5 flex items-center justify-between">
      <div>
        <h2 class="section-title">Appearance</h2>
        <p class="text-[13px] text-muted">Currently using {{ isDark ? 'dark' : 'light' }} mode on this device.</p>
      </div>
      <button class="btn-secondary" @click="toggle"><Sun v-if="isDark" class="size-4" /><Moon v-else class="size-4" />Switch to {{ isDark ? 'light' : 'dark' }}</button>
    </section>

    <section class="card p-5">
      <h2 class="section-title">Password</h2>
      <p class="text-[13px] text-muted mt-1">Sign out and use “Forgot password?” on the sign-in page to receive a reset link.</p>
    </section>

    <section class="card p-5 animate-in">
      <h2 class="section-title">Notifications</h2>
      <p class="text-[13px] text-muted mt-1">What your AI staff tell you about (the bell at the top of the menu).</p>
      <div v-if="!notif.prefs.value" class="skeleton h-24 mt-4" />
      <div v-else class="mt-4 space-y-2.5 text-[13px]">
        <label class="flex items-center justify-between gap-4"><span>A task I gave (or a schedule I own) is <b>done</b></span><input type="checkbox" class="size-4 accent-[var(--color-brand)]" :checked="notif.prefs.value.taskCompleted" @change="setPref('taskCompleted', ($event.target as HTMLInputElement).checked)" /></label>
        <label class="flex items-center justify-between gap-4"><span>A task <b>failed</b></span><input type="checkbox" class="size-4 accent-[var(--color-brand)]" :checked="notif.prefs.value.taskFailed" @change="setPref('taskFailed', ($event.target as HTMLInputElement).checked)" /></label>
        <label class="flex items-center justify-between gap-4"><span>An AI employee needs my <b>approval</b>, or my request was decided</span><input type="checkbox" class="size-4 accent-[var(--color-brand)]" :checked="notif.prefs.value.approvals" @change="setPref('approvals', ($event.target as HTMLInputElement).checked)" /></label>
        <label class="flex items-center justify-between gap-4"><span>An AI employee found a <b>new problem</b> in its responsibility</span><input type="checkbox" class="size-4 accent-[var(--color-brand)]" :checked="notif.prefs.value.issues" @change="setPref('issues', ($event.target as HTMLInputElement).checked)" /></label>
        <label class="flex items-center justify-between gap-4 pt-2.5 border-t border-line">
          <span>Also pop up as <b>browser notifications</b> while Widebed is open in a tab<span v-if="browserState === 'denied'" class="block text-[12px] text-warn">Blocked by your browser — allow it in the site settings (padlock next to the address).</span><span v-else-if="browserState === 'unsupported'" class="block text-[12px] text-subtle">This browser doesn’t support it.</span></span>
          <input type="checkbox" class="size-4 accent-[var(--color-brand)]" :disabled="browserState === 'unsupported'" :checked="notif.prefs.value.browser" @change="setPref('browser', ($event.target as HTMLInputElement).checked)" />
        </label>
      </div>
    </section>

    <template v-if="isAdmin">
      <h2 class="text-[12px] font-medium text-subtle uppercase tracking-wide pt-4">For Super Admins</h2>

      <section class="card p-5 animate-in">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h2 class="section-title flex items-center gap-2"><BellRing class="size-4 text-muted" />Failure alerts</h2>
            <p class="text-[13px] text-muted mt-1">Email someone when a live workflow fails. Test runs from the editor never send alerts.</p>
          </div>
          <label v-if="sys" class="inline-flex items-center gap-2 text-[13px] cursor-pointer shrink-0">
            <input v-model="sys.alerts.enabled" type="checkbox" class="size-4 accent-[var(--color-brand)]" />
            {{ sys.alerts.enabled ? 'On' : 'Off' }}
          </label>
        </div>

        <div v-if="!sys" class="skeleton h-24 mt-4" />
        <form v-else class="grid gap-4 mt-4" @submit.prevent="saveAlerts">
          <div>
            <label class="label">Send from (Google account)</label>
            <select v-model="sys.alerts.credentialId" class="input">
              <option :value="null">Choose an account…</option>
              <option v-for="c in googleAccounts" :key="c.credentialId" :value="c.credentialId">{{ c.name }}{{ c.details.accountEmail ? ` (${c.details.accountEmail})` : '' }}</option>
            </select>
            <p v-if="!googleAccounts.length" class="text-[12px] text-subtle mt-1">No Google account yet — <RouterLink to="/credentials" class="text-brand hover:underline">connect one on the Credentials page</RouterLink> (tick Gmail).</p>
          </div>
          <div>
            <label class="label">Send to</label>
            <div class="flex flex-wrap items-center gap-1.5 input h-auto min-h-9 py-1.5">
              <span v-for="(e, i) in sys.alerts.emails" :key="e" class="chip inline-flex items-center gap-1">
                {{ e }}<button type="button" :aria-label="`Remove ${e}`" class="hover:text-bad" @click="sys.alerts.emails.splice(i, 1)"><X class="size-3" /></button>
              </span>
              <input
                v-model="newEmail"
                class="flex-1 min-w-[160px] bg-transparent outline-none text-[13px]"
                placeholder="Type an email and press Enter"
                @keydown.enter.prevent="addEmail"
                @keydown.,.prevent="addEmail"
                @blur="addEmail"
              />
            </div>
          </div>
          <div>
            <label class="label">At most one email per workflow every</label>
            <select v-model.number="sys.alerts.cooldownMinutes" class="input w-auto">
              <option :value="15">15 minutes</option>
              <option :value="60">1 hour</option>
              <option :value="240">4 hours</option>
              <option :value="1440">1 day</option>
            </select>
          </div>
          <div class="flex flex-wrap gap-2 justify-end">
            <button type="button" class="btn-secondary" :disabled="testing || !sys.alerts.credentialId || (!sys.alerts.emails.length && !newEmail)" @click="testAlert"><Send class="size-4" />Send test email</button>
            <button type="submit" class="btn-primary" :disabled="saving">Save</button>
          </div>
        </form>
      </section>

      <section v-if="sys" class="card p-5 animate-in">
        <h2 class="section-title">Code steps</h2>
        <p class="text-[13px] text-muted mt-1 mb-3">Who may add and change <b>Code</b> steps (JavaScript). Code runs in a locked sandbox: no internet, no files, a time limit and a memory limit.</p>
        <div class="flex flex-col gap-2 text-[13.5px]">
          <label class="flex items-start gap-2"><input type="radio" name="code-access" class="mt-1 accent-[var(--wb-brand)]" :checked="(sys.code?.whoCanWrite ?? 'it_admin') === 'it_admin'" :disabled="savingCode" @change="saveCodeAccess('it_admin')" /><span><b>Only IT Admins</b> (and Super Admins) — safest</span></label>
          <label class="flex items-start gap-2"><input type="radio" name="code-access" class="mt-1 accent-[var(--wb-brand)]" :checked="sys.code?.whoCanWrite === 'editors'" :disabled="savingCode" @change="saveCodeAccess('editors')" /><span><b>Everyone who builds workflows</b> (Admins and Department Managers), in workflows they may edit</span></label>
        </div>
      </section>

      <section class="card p-5 animate-in" style="--i: 1">
        <h2 class="section-title">Backup and restore</h2>
        <p class="text-[13px] text-muted mt-1">
          One file with every workflow. Passwords and keys are never included. Restoring adds the workflows as new, switched-off copies — nothing you have now is overwritten.
        </p>
        <div class="flex flex-wrap gap-2 mt-4">
          <button class="btn-primary" @click="downloadBackup"><Download class="size-4" />Download backup</button>
          <label class="btn-secondary cursor-pointer" :class="{ 'opacity-50 pointer-events-none': restoring && restoring.done < restoring.total }">
            <Upload class="size-4" />Restore from backup…
            <input type="file" accept=".json,application/json" class="hidden" @change="restore" />
          </label>
        </div>
        <div v-if="restoring" class="mt-4 text-[13px]">
          <div class="h-1.5 rounded-full bg-surface-2 overflow-hidden">
            <div class="h-full bg-brand transition-[width] duration-300" :style="{ width: `${(restoring.done / restoring.total) * 100}%` }" />
          </div>
          <p class="text-muted mt-1.5">{{ restoring.done }} of {{ restoring.total }} workflows<template v-if="restoring.done === restoring.total"> — done. <RouterLink to="/workflows" class="text-brand hover:underline">Open Workflows</RouterLink></template></p>
          <p v-if="restoring.failed.length" class="text-bad mt-1">Couldn’t restore: {{ restoring.failed.join(', ') }}</p>
        </div>
      </section>

      <section class="card p-5">
        <h2 class="section-title">Server limits</h2>
        <p class="text-[13px] text-muted mt-1">
          Run time limits, how many workflows run at once, and network rules are set by IT on the server (the <code>.env</code> file). See <code>docs/DEPLOYMENT.md</code>.
        </p>
      </section>
    </template>
  </div>
</template>
