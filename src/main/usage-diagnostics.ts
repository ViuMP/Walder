/**
 * Text for the two usage-shape diagnostics, and a tiny "have I already said
 * this" gate so they show up once per run instead of once per three-minute
 * poll for as long as Walder stays open.
 *
 * Electron-free, like `core/` — every function here is pure text formatting —
 * but it lives in `main/` rather than `core/` because its only reason to exist
 * is to feed `vlog`. Nothing in the renderer, and nothing in the bucket
 * parser itself, needs a log line; `core/buckets.ts` only had to grow a shape
 * (`IgnoredWindow`) to describe what was dropped, never the words to print
 * about it.
 *
 * Both lines exist because of the same incident. `amber_ladder` (2026-09-10)
 * was on the owner's account for who knows how long before anyone noticed it
 * on the card — there was no way to see *what a payload actually contained*
 * short of reading a raw dump by hand. `keySetLine` is the fix for that: one
 * line, once per distinct key set per provider, that would have flagged the
 * new key the day it first appeared. `ignoredWindowLine` is the fix for the
 * next one — once the whitelist exists, *something* has to say when it drops
 * a key, or a real new allowance being silently rejected looks identical to a
 * codename being correctly rejected, and nobody would know to check.
 *
 * Neither line ever carries a percentage, a reset instant, or a raw payload —
 * only a key name, a yes/no, and (for a reset) the bare date. That is on
 * purpose: these are diagnostics for a developer deciding "is this a new
 * window or another `amber_ladder`?", not a place `redact` needs to work
 * hard to protect the owner's own numbers from.
 */
import type { IgnoredWindow } from '../core/buckets';

/**
 * "usage: ignoring unknown claude window "amber_ladder" (utilization present,
 * resets 2026-10-02) [claude-web]"
 *
 * The three shape facts a developer needs to judge the drop: which key, did it
 * carry a usage number, and does it have a reset date — never the number or
 * the timestamp's time-of-day, just enough to search Anthropic's changelog or
 * ask "does this look like a new model tier?".
 */
export function ignoredWindowLine(provider: string, w: IgnoredWindow): string {
  const utilizationPart = w.hasUtilization ? 'utilization present' : 'utilization absent';
  const resetPart = w.resetsOn === null ? 'no reset' : `resets ${w.resetsOn}`;
  return `usage: ignoring unknown claude window "${w.key}" (${utilizationPart}, ${resetPart}) [${provider}]`;
}

/**
 * "usage keys [claude-web]: amber_ladder,five_hour,nimbus_quill,seven_day"
 *
 * Sorted so the same key set always prints the same line — which is also what
 * makes `once` below collapse repeats of it, and what makes a diff between two
 * runs meaningful instead of an artefact of `Object.keys` order.
 */
export function keySetLine(provider: string, keys: readonly string[]): string {
  return `usage keys [${provider}]: ${[...keys].sort().join(',')}`;
}

/**
 * Wrap `emit` so it only ever runs once per distinct `keyOf(arg)` — for the
 * lifetime of this closure, which `provider-chains.ts` creates once per app
 * run. A three-minute poll would otherwise repeat the same line forever; the
 * point of both lines is to be *noticed once*, not to narrate every tick.
 */
export function once<A>(keyOf: (arg: A) => string, emit: (arg: A) => void): (arg: A) => void {
  const seen = new Set<string>();
  return (arg: A): void => {
    const key = keyOf(arg);
    if (seen.has(key)) return;
    seen.add(key);
    emit(arg);
  };
}
