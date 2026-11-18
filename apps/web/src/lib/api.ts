import { auth } from './firebase';
import { track } from './loading';

const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function token(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new ApiError(401, 'Not signed in');
  return user.getIdToken();
}

/** Small fetch wrapper: adds the Firebase ID token and turns errors into ApiError. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; query?: Record<string, unknown>; quiet?: boolean } = {}): Promise<T> {
  const end = track({ quiet: init.quiet });
  try {
    return await request<T>(path, init);
  } finally {
    end();
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown; query?: Record<string, unknown> }): Promise<T> {
  const url = new URL(`${BASE}/api${path}`, window.location.origin);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${await token()}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.details);
  return data as T;
}

/**
 * Subscribes to Server-Sent Events with fetch(), so the token goes in a
 * header instead of the URL. Returns a function that stops the stream.
 */
export function streamEvents(path: string, onEvent: (type: string, data: any) => void, onEnd?: () => void): () => void {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${BASE}/api${path}`, {
        headers: { Authorization: `Bearer ${await token()}`, Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Stream failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let type = 'message';
          let data = '';
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event: ')) type = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) onEvent(type, JSON.parse(data));
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') console.warn('[stream]', err);
    } finally {
      onEnd?.();
    }
  })();
  return () => ctrl.abort();
}

/** Fetches a file from the API with the sign-in token (for images and downloads that need it). */
export async function apiBlob(path: string, opts: { quiet?: boolean } = {}): Promise<Blob> {
  const end = track(opts);
  try {
    const res = await fetch(new URL(`${BASE}/api${path}`, window.location.origin), { headers: { Authorization: `Bearer ${await token()}` } });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
    }
    return await res.blob();
  } finally {
    end();
  }
}

/**
 * Sends a file's bytes to the API (no JSON). Used to read text out of documents:
 * the server returns the text and does not keep the file.
 */
export async function apiUpload<T = unknown>(path: string, file: Blob, query: Record<string, string> = {}): Promise<T> {
  const end = track({});
  try {
    const url = new URL(`${BASE}/api${path}`, window.location.origin);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? `Upload failed (${res.status})`, data.details);
    return data as T;
  } finally {
    end();
  }
}

/** File types the document reader understands (for <input accept>). */
export const READABLE_FILES = '.pdf,.docx,.xlsx,.txt,.md,.csv,.tsv,.json,.html,.htm';
