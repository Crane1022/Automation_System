import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Credential } from '@widebed/shared';
import { api } from '@/lib/api';

/** Connections (metadata only — secrets never reach the browser). */
export const useCredentialsStore = defineStore('credentials', () => {
  const items = ref<Credential[]>([]);
  const google = ref<{ configured: boolean; redirectUri: string }>({ configured: false, redirectUri: '' });
  const loaded = ref(false);

  async function load(force = false) {
    if (loaded.value && !force) return;
    const res = await api<{ items: Credential[]; google: typeof google.value }>('/credentials');
    items.value = res.items;
    google.value = res.google;
    loaded.value = true;
  }
  const byProvider = (provider: string) => items.value.filter((c) => c.provider === provider);
  return { items, google, loaded, load, byProvider };
});
