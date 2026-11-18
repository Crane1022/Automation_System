import { computed, ref } from 'vue';

/**
 * App-wide loading feedback.
 *
 *  - Top progress bar: shown while a page loads or any request to the server is running
 *    (after a short delay, so quick actions don't flicker).
 *  - Button spinners: when you click a button and that click starts requests, the button shows
 *    a spinner and ignores more clicks until they finish. No code needed per button.
 *
 * Background polling (e.g. the Assistant checking for progress) passes `quiet` to api() and is ignored.
 */

const pending = ref(0);
export const isBusy = computed(() => pending.value > 0);

/* ----------------------------------------------------------- button spinners */

const SHOW_AFTER_MS = 150;
let lastButton: { el: HTMLElement; at: number } | null = null;
const counts = new WeakMap<HTMLElement, number>();
const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** Remembers which button was just clicked (capture phase, before the click handler runs). */
export function installClickTracking() {
  document.addEventListener(
    'click',
    (e) => {
      const el = (e.target as HTMLElement | null)?.closest?.('button, [role="button"]') as HTMLElement | null;
      lastButton = el && !el.hasAttribute('data-no-loading') ? { el, at: Date.now() } : null;
    },
    true,
  );
}

function claimButton(): HTMLElement | null {
  // Requests started within half a second of a click belong to that button.
  if (!lastButton || Date.now() - lastButton.at > 500 || !lastButton.el.isConnected) return null;
  return lastButton.el;
}

function buttonStart(el: HTMLElement) {
  const n = (counts.get(el) ?? 0) + 1;
  counts.set(el, n);
  el.setAttribute('aria-busy', 'true');
  if (n === 1) {
    timers.set(
      el,
      setTimeout(() => {
        if ((counts.get(el) ?? 0) > 0) el.classList.add('is-loading');
      }, SHOW_AFTER_MS),
    );
  }
}

function buttonEnd(el: HTMLElement) {
  const n = Math.max(0, (counts.get(el) ?? 1) - 1);
  counts.set(el, n);
  if (n === 0) {
    clearTimeout(timers.get(el));
    el.classList.remove('is-loading');
    el.removeAttribute('aria-busy');
  }
}

/**
 * Wraps one piece of work (a request or a page load). Returns the function to call when it ends.
 * `quiet` work (background polling) shows nothing.
 */
export function track(opts: { quiet?: boolean } = {}): () => void {
  if (opts.quiet) return () => undefined;
  pending.value++;
  const btn = claimButton();
  if (btn) buttonStart(btn);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    pending.value = Math.max(0, pending.value - 1);
    if (btn) buttonEnd(btn);
  };
}
