import { ref } from 'vue';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

const toasts = ref<Toast[]>([]);
let next = 1;

export function useToasts() {
  return toasts;
}

export function toast(message: string, kind: Toast['kind'] = 'info', ms = 4000) {
  const id = next++;
  toasts.value.push({ id, kind, message });
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), ms);
}

export const toastError = (err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error', 6000);
