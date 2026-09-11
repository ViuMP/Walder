/**
 * Text for the diagnostics that `main/` emits once per app run.
 *
 * These ship as safe, value-free log lines. The separate pure usage-shape
 * formatter lives in `core/` so providers can use it without importing main.
 */
import type { IgnoredWindow } from '../core/buckets';

/**
 * Format the details of a Claude window the parser deliberately ignored.
 * The line carries a key, yes/no utilization state, and a bare reset date;
 * never a percentage, reset instant, or raw account value.
 */
export function ignoredWindowLine(provider: string, w: IgnoredWindow): string {
  const utilizationPart = w.hasUtilization ? 'utilization present' : 'utilization absent';
  const resetPart = w.resetsOn === null ? 'no reset' : `resets ${w.resetsOn}`;
  return `usage: ignoring unknown claude window "${w.key}" (${utilizationPart}, ${resetPart}) [${provider}]`;
}

/** Sort keys so equivalent responses produce the same one-time diagnostic. */
export function keySetLine(provider: string, keys: readonly string[]): string {
  return `usage keys [${provider}]: ${[...keys].sort().join(', ')}`;
}

/**
 * Call `emit` only once per key for this closure. `shouldEmit` is checked
 * before remembering a key so enabling verbose logging later still produces
 * the diagnostic on the next refresh.
 */
export function once<A>(
  keyOf: (arg: A) => string,
  emit: (arg: A) => void,
  shouldEmit: () => boolean = () => true
): (arg: A) => void {
  const seen = new Set<string>();
  return (arg: A): void => {
    if (!shouldEmit()) return;
    const key = keyOf(arg);
    if (seen.has(key)) return;
    seen.add(key);
    emit(arg);
  };
}
