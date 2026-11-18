<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { firebaseConfigured } from '@/lib/firebase';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const email = ref('');
const password = ref('');
const remember = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);

function friendly(code: string) {
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'Incorrect email or password.';
  if (code.includes('too-many-requests')) return 'Too many attempts. Try again in a few minutes or reset your password.';
  if (code.includes('network')) return 'Network error. Check your connection.';
  return 'Sign-in failed. Please try again.';
}

async function submit() {
  busy.value = true;
  error.value = null;
  try {
    await auth.login(email.value.trim(), password.value, remember.value);
    if (auth.profile) router.replace((route.query.next as string) || '/');
  } catch (err: any) {
    error.value = friendly(err?.code ?? String(err));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="min-h-full grid lg:grid-cols-[1fr_480px]">
    <div class="hidden lg:flex flex-col justify-between p-12 bg-brand text-white relative overflow-hidden">
      <div class="flex items-center gap-2.5">
        <img src="/favicon.svg" class="size-8 rounded-lg ring-1 ring-white/20" alt="" />
        <span class="font-semibold">Widebed Automation</span>
      </div>
      <div class="max-w-md">
        <h1 class="text-[28px] font-semibold leading-tight tracking-tight">Automate the work between PMS, TMS and the tools your team already uses.</h1>
        <p class="mt-3 text-white/70 text-[14px]">Build workflows visually, publish them safely, and see every run step by step.</p>
      </div>
      <svg class="absolute -right-24 -bottom-24 w-[420px] opacity-[0.08]" viewBox="0 0 200 200" fill="none" stroke="white" stroke-width="1.5">
        <circle cx="40" cy="60" r="14" /><circle cx="110" cy="40" r="14" /><circle cx="110" cy="120" r="14" /><circle cx="170" cy="80" r="14" />
        <path d="M54 60 C80 60 80 40 96 40 M54 60 C80 60 80 120 96 120 M124 40 C150 40 150 80 156 80 M124 120 C150 120 150 80 156 80" />
      </svg>
      <p class="text-[12px] text-white/50">Internal platform · Widebed</p>
    </div>

    <div class="flex items-center justify-center p-6 bg-canvas">
      <div class="w-full max-w-[360px]">
        <div class="lg:hidden flex items-center gap-2 mb-8">
          <img src="/favicon.svg" class="size-7" alt="" /><span class="font-semibold">Widebed Automation</span>
        </div>
        <h2 class="text-[20px] font-semibold tracking-tight">Sign in</h2>
        <p class="text-muted text-[13px] mt-1 mb-6">Use your Widebed account.</p>

        <div v-if="!firebaseConfigured" class="mb-4 rounded-md border border-warn/30 bg-warn-soft text-warn text-[13px] p-3">
          Firebase is not configured. Set the <code>VITE_FIREBASE_*</code> variables (see <code>apps/web/.env.example</code>).
        </div>
        <div v-if="auth.isSignedIn && auth.accessError" class="mb-4 rounded-md border border-warn/30 bg-warn-soft text-[13px] p-3">
          <p class="text-warn font-medium">{{ auth.accessError }}</p>
          <button class="mt-2 text-[12px] underline text-muted" @click="auth.logout()">Sign in with a different account</button>
        </div>

        <form class="space-y-4" @submit.prevent="submit">
          <div>
            <label class="label" for="email">Email</label>
            <input id="email" v-model="email" type="email" autocomplete="username" required class="input h-9" />
          </div>
          <div>
            <div class="flex items-center justify-between">
              <label class="label" for="password">Password</label>
              <RouterLink to="/reset-password" class="text-[12px] text-brand hover:underline mb-1">Forgot password?</RouterLink>
            </div>
            <input id="password" v-model="password" type="password" autocomplete="current-password" required class="input h-9" />
          </div>
          <label class="flex items-center gap-2 text-[13px] text-muted">
            <input v-model="remember" type="checkbox" class="accent-[var(--wb-brand)]" /> Keep me signed in on this device
          </label>
          <p v-if="error" class="text-bad text-[13px]">{{ error }}</p>
          <button class="btn-primary w-full h-9" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
        </form>
      </div>
    </div>
  </div>
</template>
