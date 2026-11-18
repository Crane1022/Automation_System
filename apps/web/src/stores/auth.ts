import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  type User,
} from 'firebase/auth';
import type { AppUser, Permission } from '@widebed/shared';
import { hasPermission } from '@widebed/shared';
import { auth } from '@/lib/firebase';
import { api, ApiError } from '@/lib/api';

export const useAuthStore = defineStore('auth', () => {
  const firebaseUser = ref<User | null>(null);
  /** Profile from our API (role, department). This is what the backend enforces. */
  const profile = ref<AppUser | null>(null);
  const ready = ref(false);
  const accessError = ref<string | null>(null);

  let readyResolve: () => void;
  const readyPromise = new Promise<void>((r) => (readyResolve = r));

  async function loadProfile() {
    accessError.value = null;
    try {
      profile.value = await api<AppUser>('/me');
    } catch (err) {
      profile.value = null;
      accessError.value = err instanceof ApiError ? err.message : 'Could not reach the server';
    }
  }

  onAuthStateChanged(auth, async (u) => {
    firebaseUser.value = u;
    if (u) await loadProfile();
    else profile.value = null;
    ready.value = true;
    readyResolve();
  });

  async function login(email: string, password: string, remember: boolean) {
    await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
    await signInWithEmailAndPassword(auth, email, password);
    await loadProfile();
    if (profile.value) api('/me/session', { method: 'POST' }).catch(() => undefined);
  }

  async function logout() {
    await signOut(auth);
    profile.value = null;
  }

  const resetPassword = (email: string) => sendPasswordResetEmail(auth, email);
  const can = (p: Permission) => !!profile.value && hasPermission(profile.value, p);

  return {
    firebaseUser,
    profile,
    ready,
    readyPromise,
    accessError,
    isSignedIn: computed(() => !!firebaseUser.value),
    login,
    logout,
    resetPassword,
    loadProfile,
    can,
  };
});
