/**
 * Verbose main-process logging, off by default.
 *
 * The owner never sees a terminal, so a chatty mascot would only fill a log file
 * nobody reads — and the hit/drag channels fire on every mouse move. Run
 * `WALDER_LOG=1 npm run dev` to turn diagnostics on.
 */
const VERBOSE = process.env['WALDER_LOG'] === '1';

export const verbose = VERBOSE;

/** Log a diagnostic line. No-op unless `WALDER_LOG=1`. */
export function vlog(...args: unknown[]): void {
  if (VERBOSE) console.log('[walder]', ...args);
}

/** Log a real problem. Always printed — these mean something is broken. */
export function warn(...args: unknown[]): void {
  console.warn('[walder]', ...args);
}
