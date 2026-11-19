/**
 * The notification fallback's one sink: a bark nobody can see, posted as a
 * system toast, with a log line for every attempt and every outcome.
 *
 * Until 2026-11-19 this was two lines in `index.ts` that logged nothing, so a
 * toast that never appeared (Windows QA 9.23, twice) left no trace of whether
 * it was declined, posted and swallowed by the system, or failed. Now each one
 * writes `posting`, then `shown`, `failed` or `clicked` as Electron reports
 * them. Always written (`info`), not verbose-only: the owner cannot tick
 * Verbose log before the miss he is about to report.
 *
 * **Never the text.** A bark carries his percentages; the lines name the bubble
 * kind and the event, nothing else (AGENTS.md: no usage values in the log).
 *
 * **Held until it closes.** A `Notification` nothing references can be garbage
 * collected with its listeners while the system still has it, so `shown` and
 * `click` would never be heard; Electron's own docs say to keep a reference.
 * A macOS banner that times out into Notification Center emits neither `close`
 * nor `failed`, so at most `MAX_LIVE` are held and the oldest is let go.
 */
import { Notification } from 'electron';
import { info, warn } from './log';

/** The slice of Electron's `Notification` class used here; a fake in the tests. */
export interface ToastClass {
  isSupported(): boolean;
  new (options: Electron.NotificationConstructorOptions): Electron.Notification;
}

/** Toasts posted and not yet closed or failed, oldest first. */
const live = new Set<Electron.Notification>();
// shortcut: the oldest beyond 20 loses its reference (a late click on it may go unlogged), raise it if that is ever missed.
const MAX_LIVE = 20;

/** How many are held right now; for the tests. */
export function liveToasts(): number {
  return live.size;
}

/**
 * Post `body` as a silent toast titled Walder. `kind` is the bubble kind, the
 * only thing about it that is logged. Constructed here, at delivery, never at
 * launch: macOS asks for permission the first time one is built.
 */
export function postToast(kind: string, body: string, Toast: ToastClass = Notification): void {
  const what = `toast for a ${kind} bark`;
  // A Linux desktop without a notification daemon is a `show()` that throws.
  if (!Toast.isSupported()) {
    info(`${what}: not supported on this system`);
    return;
  }
  const toast = new Toast({ title: 'Walder', body, silent: true });
  live.add(toast);
  for (const old of live) {
    if (live.size <= MAX_LIVE) break;
    live.delete(old);
  }
  toast.on('show', () => info(`${what}: shown`));
  toast.on('click', () => info(`${what}: clicked`));
  toast.on('failed', (_event, error) => {
    live.delete(toast);
    // The error is the system's own sentence about the toast, never our text.
    warn(`${what}: failed:`, error);
  });
  toast.on('close', () => live.delete(toast));
  info(`${what}: posting`);
  toast.show();
}
