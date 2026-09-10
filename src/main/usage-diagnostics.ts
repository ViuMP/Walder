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
  // The key sits alone in quotes, not comma-joined against another key, so
  // the multi-key bleed-together `keySetLine` below has to guard against
  // cannot happen here. That does not save a single key that is itself 20+
  // characters of letters/digits/`_`/`+`/`=`/`-` — quoting adds punctuation
  // *around* the run, not inside it, so `log.ts`'s `BASE64ISH_RE` still masks
  // a key like `seven_day_claude_sonnet_4` whole, quotes or not. Known and
  // accepted: window key names this long are rare, this line is a developer
  // diagnostic rather than the owner's own card, and loosening
  // `BASE64ISH_RE` to spare it would weaken the one thing that filter exists
  // to catch.
  return `usage: ignoring unknown claude window "${w.key}" (${utilizationPart}, ${resetPart}) [${provider}]`;
}

/**
 * "usage keys [claude-web]: amber_ladder, five_hour, nimbus_quill, seven_day"
 *
 * Sorted so the same key set always prints the same line — which is also what
 * makes `once` below collapse repeats of it, and what makes a diff between two
 * runs meaningful instead of an artefact of `Object.keys` order.
 *
 * Joined with `', '`, not `','`: `log.ts`'s `BASE64ISH_RE` masks any 20+
 * character run of letters/digits/`_`/`+`/`=`/`-`, and neither a comma nor a
 * space is in that class, so either already stops one key's run from bleeding
 * into the next — the comma+space is kept for readability, not because the
 * bare comma would have let two short keys merge into one run. It does not,
 * and cannot, rescue a single key that is on its own 20+ characters (see
 * `ignoredWindowLine`'s comment): no separator placed *outside* a run can
 * break characters *inside* it.
 */
export function keySetLine(provider: string, keys: readonly string[]): string {
  return `usage keys [${provider}]: ${[...keys].sort().join(', ')}`;
}

/**
 * Wrap `emit` so it only ever runs once per distinct `keyOf(arg)` — for the
 * lifetime of this closure, which `provider-chains.ts` creates once per app
 * run. A three-minute poll would otherwise repeat the same line forever; the
 * point of both lines is to be *noticed once*, not to narrate every tick.
 *
 * `shouldEmit`, when given, is checked *before* `keyOf`/`seen` — not after —
 * so a key seen while diagnostics are off is never recorded at all. The bug
 * this fixes (2026-09-10): with verbose logging off, `once` still added every
 * key it saw to `seen`, and only `vlog` — silently, since it no-ops when not
 * verbose — dropped the line. So ticking **Developer ▸ Verbose log** and
 * pressing **Refresh now** (the documented QA 4.16 procedure) produced
 * nothing, because every key had already been marked "seen" during the quiet
 * runs before anyone turned logging on. Checking `shouldEmit` first means
 * flipping verbose logging on always gets a fresh line per key, which is the
 * whole point of ticking that box.
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
