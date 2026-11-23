import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { CustomStep } from '@widebed/shared';
import { api } from '@/lib/api';

export type TeamStep = CustomStep & { canManage: boolean };

export interface SaveTeamStep {
  name: string;
  description: string;
  baseType: string;
  config: Record<string, unknown>;
  credentialId?: string | null;
  fields: { key: string; label: string; help?: string }[];
  shareWith: 'team' | 'everyone';
}

/** Steps saved by the team ("My team's steps"). */
export const useCustomStepsStore = defineStore('customSteps', () => {
  const items = ref<TeamStep[]>([]);
  const loaded = ref(false);
  let pending: Promise<void> | null = null;

  function load(force = false) {
    if (loaded.value && !force) return Promise.resolve();
    pending ??= api<{ items: TeamStep[] }>('/custom-steps')
      .then((r) => {
        items.value = r.items;
        loaded.value = true;
      })
      .finally(() => (pending = null));
    return pending;
  }

  async function create(body: SaveTeamStep) {
    const step = await api<TeamStep>('/custom-steps', { method: 'POST', body });
    items.value = [...items.value, step].sort((a, b) => a.name.localeCompare(b.name));
    return step;
  }

  async function update(stepId: string, body: Partial<SaveTeamStep>) {
    const step = await api<TeamStep>(`/custom-steps/${stepId}`, { method: 'PATCH', body });
    items.value = items.value.map((s) => (s.stepId === stepId ? step : s));
    return step;
  }

  async function remove(stepId: string) {
    await api(`/custom-steps/${stepId}`, { method: 'DELETE' });
    items.value = items.value.filter((s) => s.stepId !== stepId);
  }

  const get = (stepId: unknown) => items.value.find((s) => s.stepId === stepId);
  return { items, loaded, load, create, update, remove, get };
});
