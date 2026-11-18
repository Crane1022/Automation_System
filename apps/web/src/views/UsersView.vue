<script setup lang="ts">
import Skeleton from '@/components/ui/Skeleton.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import { onMounted, ref } from 'vue';
import type { AppUser, Role } from '@widebed/shared';
import { ROLES } from '@widebed/shared';
import { api } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';
import { roleLabels, timeAgo } from '@/lib/format';
import { useAuthStore } from '@/stores/auth';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import Modal from '@/components/ui/Modal.vue';
import { Mail, UserPlus } from '@lucide/vue';

const auth = useAuthStore();
const users = ref<AppUser[]>([]);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    users.value = (await api<{ items: AppUser[] }>('/users')).items;
  } catch (err) {
    toastError(err);
  } finally {
    loading.value = false;
  }
}

async function update(u: AppUser, patch: Partial<Pick<AppUser, 'role' | 'department' | 'status'>>) {
  try {
    const updated = await api<AppUser>(`/users/${u.uid}`, { method: 'PATCH', body: patch });
    Object.assign(u, updated);
    toast(`${u.name} updated`, 'success', 2000);
  } catch (err) {
    toastError(err);
    load();
  }
}
const showInvite = ref(false);
const inviting = ref(false);
const form = ref({ email: '', name: '', role: 'employee' as Role, department: '' });

/**
 * 1. The API creates the Firebase account + profile (active, with the role).
 * 2. Firebase emails the person a link to set their own password.
 */
async function invite() {
  inviting.value = true;
  try {
    const email = form.value.email.trim().toLowerCase();
    await api('/users/invite', { method: 'POST', body: { ...form.value, email, department: form.value.department.trim() || null } });
    await auth.resetPassword(email);
    toast(`Invitation sent to ${email}`, 'success');
    showInvite.value = false;
    form.value = { email: '', name: '', role: 'employee', department: '' };
    load();
  } catch (err) {
    toastError(err);
  } finally {
    inviting.value = false;
  }
}

async function sendPasswordLink(u: AppUser) {
  try {
    await auth.resetPassword(u.email);
    toast(`Password link sent to ${u.email}`, 'success');
  } catch (err) {
    toastError(err);
  }
}

onMounted(load);
</script>

<template>
  <div class="p-6 lg:p-8 max-w-[1280px] mx-auto">
    <PageHeader title="Users & Permissions" subtitle="Only administrators can add people. Invited users get an email to set their password.">
      <button class="btn-primary" @click="showInvite = true"><UserPlus class="size-4" />Invite user</button>
    </PageHeader>

    <div class="card overflow-x-auto">
      <Skeleton v-if="loading" kind="table" :rows="6" />
      <table v-else class="w-full min-w-[820px]">
        <thead>
          <tr>
            <th class="table-head">User</th>
            <th class="table-head">Role</th>
            <th class="table-head">Department</th>
            <th class="table-head">Status</th>
            <th class="table-head">Last sign-in</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(u, idx) in users" :key="u.uid" class="animate-in" :style="{ '--i': idx }">
            <td class="table-cell">
              <div class="font-medium">{{ u.name }} <span v-if="u.uid === auth.profile?.uid" class="chip ml-1">you</span></div>
              <div class="text-[12px] text-subtle">{{ u.email }}</div>
            </td>
            <td class="table-cell">
              <select class="input w-[190px]" :value="u.role" :disabled="u.uid === auth.profile?.uid" @change="update(u, { role: ($event.target as HTMLSelectElement).value as Role })">
                <option v-for="r in ROLES" :key="r" :value="r">{{ roleLabels[r] }}</option>
              </select>
            </td>
            <td class="table-cell">
              <input class="input w-[160px]" :value="u.department ?? ''" placeholder="—" @change="update(u, { department: ($event.target as HTMLInputElement).value.trim() || null })" />
            </td>
            <td class="table-cell">
              <div class="flex items-center gap-2">
                <StatusBadge :status="u.status" />
                <template v-if="u.uid !== auth.profile?.uid">
                  <button v-if="u.status !== 'active'" class="btn-secondary h-7 text-[12px]" @click="update(u, { status: 'active' })">Activate</button>
                  <button v-else class="btn-ghost h-7 text-[12px]" @click="update(u, { status: 'disabled' })">Disable</button>
                </template>
              </div>
            </td>
            <td class="table-cell text-muted">
              <div class="flex items-center justify-between gap-2">
                {{ u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'Never signed in' }}
                <button class="btn-ghost h-7 text-[12px]" title="Email a link to set or reset the password" @click="sendPasswordLink(u)"><Mail class="size-3.5" />Send link</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card p-4 mt-4 text-[13px]">
      <h2 class="section-title mb-2">What each role can do</h2>
      <ul class="grid md:grid-cols-2 gap-x-6 gap-y-1.5 text-muted">
        <li><b class="text-ink">Super Admin</b> — everything, including users and settings.</li>
        <li><b class="text-ink">Admin</b> — all workflows and executions, integrations, audit log.</li>
        <li><b class="text-ink">IT Admin</b> — all workflows, credentials, integrations, debugging.</li>
        <li><b class="text-ink">Department Manager</b> — workflows and executions of their department.</li>
        <li><b class="text-ink">Employee</b> — workflows shared with them; their own executions.</li>
      </ul>
    </div>

    <Modal v-if="showInvite" title="Invite user" @close="showInvite = false">
      <form id="invite-form" class="space-y-4" @submit.prevent="invite">
        <div><label class="label">Full name</label><input v-model="form.name" class="input" required maxlength="120" /></div>
        <div><label class="label">Email</label><input v-model="form.email" type="email" class="input" required /></div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="label">Role</label>
            <select v-model="form.role" class="input">
              <option v-for="r in ROLES" :key="r" :value="r">{{ roleLabels[r] }}</option>
            </select>
          </div>
          <div><label class="label">Department</label><input v-model="form.department" class="input" placeholder="e.g. Operations" /></div>
        </div>
        <p class="text-[12px] text-subtle">
          They will receive an email from Firebase with a link to choose their password, then sign in here.
          The link expires after a while — use “Send link” in the list to send a new one.
        </p>
      </form>
      <template #footer>
        <button class="btn-secondary" @click="showInvite = false">Cancel</button>
        <button class="btn-primary" form="invite-form" type="submit" :disabled="inviting">{{ inviting ? 'Inviting…' : 'Send invitation' }}</button>
      </template>
    </Modal>
  </div>
</template>
