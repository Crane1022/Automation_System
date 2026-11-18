<script setup lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const email = ref('');
const busy = ref(false);
const sent = ref(false);

async function submit() {
  busy.value = true;
  try {
    await auth.resetPassword(email.value.trim());
  } catch {
    /* Do not reveal whether the email exists. */
  } finally {
    sent.value = true;
    busy.value = false;
  }
}
</script>

<template>
  <div class="min-h-full grid place-items-center p-6">
    <div class="card w-full max-w-[380px] p-6">
      <h2 class="text-[18px] font-semibold">Reset password</h2>
      <p class="text-muted text-[13px] mt-1 mb-5">We will email you a link to choose a new password.</p>
      <div v-if="sent" class="rounded-md bg-ok-soft text-ok text-[13px] p-3">
        If an account exists for that address, a reset link is on its way.
      </div>
      <form v-else class="space-y-4" @submit.prevent="submit">
        <div>
          <label class="label" for="email">Email</label>
          <input id="email" v-model="email" type="email" required class="input h-9" />
        </div>
        <button class="btn-primary w-full h-9" :disabled="busy">Send reset link</button>
      </form>
      <RouterLink to="/login" class="block text-center text-[13px] text-brand mt-5 hover:underline">Back to sign in</RouterLink>
    </div>
  </div>
</template>
