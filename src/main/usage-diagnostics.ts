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
 *
 * `usageShapeLines` at the bottom of this file is the deliberate exception,
 * and is treated as one: it *does* print numbers, because the `limits[]` and
 * `extra_usage` parsers are still written against researched field names that
 * only one real payload can confirm. It never prints a string value, and
 * `provider-chains.ts` keeps it behind an environment variable, refuses it in
 * a packaged build, and still requires verbose logging on top. The two lines
 * above are diagnostics that ship; that one is a development tool.
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

/* --------------------------------------------- the dev-only values dump */

/**
 * Top-level keys whose *insides* the dump describes, rather than only naming
 * their type.
 *
 * `keySetLine` above answers "which keys are there?", which was enough to
 * catch `amber_ladder` and is not enough for the next question: what is
 * *inside* the containers a parser has to read — `limits`, `extra_usage`,
 * `spend`. When this shipped, those parsers were written against researched
 * field names nobody had confirmed; one run of this dump (2026-09-10) then
 * corrected both of them, which is the whole case for keeping it. The list
 * stays as it is for the next time: a parser written against a guess is a
 * parser nobody can confirm without seeing one real payload's structure.
 *
 * So: these keys, and no others. Deliberately a list rather than "expand
 * everything" — the codenames (`amber_ladder`, `tangelo`, `nimbus_quill`) and
 * the three long opaque keys on the owner's account are exactly the values
 * nobody has a use for and nobody should be printing the insides of. They get
 * one type line each and stop there.
 */
const SHAPE_DETAIL_KEYS: ReadonlySet<string> = new Set([
  'limits',
  'seven_day_breakdown',
  'extra_usage',
  'spend',
  'seven_day_omelette',
  'seven_day_cowork',
  'seven_day_opus',
  'seven_day_sonnet',
  'five_hour',
  'seven_day'
]);

/**
 * How deep the walk goes. Six is far past anything observed (`limits` is two);
 * it exists so a pathological payload cannot turn a diagnostic into a hang.
 */
const MAX_SHAPE_DEPTH = 6;

/**
 * A key as it appears in a dump line: underscores become spaces.
 *
 * Not cosmetic. `log.ts`'s `BASE64ISH_RE` masks any run of 20+ characters
 * drawn from letters/digits/`_`/`+`/`=`/`-`, and `seven_day_breakdown` (19) is
 * one character short of vanishing from its own diagnostic while
 * `seven_day_claude_sonnet_4` (25) already does. A space is not in that class,
 * so splitting the key breaks the run into words that can never reach 20
 * together — the same trick `keySetLine`'s `', '` join relies on, applied
 * *inside* the key instead of between keys.
 *
 * The limit it does **not** solve is a key that is one unbroken 20+ character
 * run with no underscore in it — three such keys sit on the owner's account,
 * and they are masked whole. That is correct behaviour from the redactor
 * (an opaque 24-character token is exactly what it exists to catch) and the
 * reason those keys are not in `SHAPE_DETAIL_KEYS` either: a line that says
 * `<redacted>: object` is honest, and there is nothing more to say about a key
 * nobody can name.
 */
function spaceKey(key: string): string {
  // Trimmed because a leading or trailing underscore is real (`_comment` in
  // the fixtures) and " comment: string" reads as a formatting bug rather than
  // as the key it is.
  return key.replace(/_+/g, ' ').trim();
}

/** `'object'`, `'array(3)'`, `'number'`, … — the type, never the value. */
function shapeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/**
 * A value as the dump is willing to print it.
 *
 * Numbers and booleans in full: a utilization of `78`, an `enabled: false`,
 * a `limit: 500` are the whole point — they are the facts that say whether a
 * field is a percent or a fraction, cents or kroner, on or off.
 *
 * **Strings never**, not one of them, and not "unless it looks safe". An
 * organisation uuid, an account slug, a plan name, an email — every identifier
 * in this payload is a string, and a rule with an exception in it is a rule
 * that leaks the first time somebody misjudges a field name. The length is
 * kept because it is genuinely diagnostic (a 20-character `resets_at` is an
 * ISO instant; a 36-character one is a uuid) and carries nothing.
 *
 * ISO timestamps are strings, so they are covered by the same rule and the
 * dump prints no instant. That is deliberate: `ignoredWindowLine` already
 * decided a bare date is the most a diagnostic needs, and this one does not
 * even need that — a reset *field* existing is the shape question.
 */
function shapeValue(value: unknown): string {
  if (typeof value === 'string') return `<string:${value.length} chars>`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return shapeType(value);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Walk one container, appending `path . key = value` lines to `out`. */
function walkShape(path: string, value: unknown, depth: number, out: string[]): void {
  if (depth > MAX_SHAPE_DEPTH) return;

  if (Array.isArray(value)) {
    // Enumerated with the index, because "the limits array has three entries"
    // and "the three entries are shaped differently" are different findings
    // and only the second one explains a parser that reads two rows out of
    // three.
    value.forEach((element, index) => {
      const elementPath = `${path} [${index}]`;
      if (isRecord(element) || Array.isArray(element)) {
        out.push(`${elementPath}: ${shapeType(element)}`);
        walkShape(elementPath, element, depth + 1, out);
      } else {
        out.push(`${elementPath} = ${shapeValue(element)}`);
      }
    });
    return;
  }

  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = `${path} . ${spaceKey(key)}`;
    if (isRecord(nested) || Array.isArray(nested)) {
      out.push(`${nestedPath}: ${shapeType(nested)}`);
      walkShape(nestedPath, nested, depth + 1, out);
    } else {
      out.push(`${nestedPath} = ${shapeValue(nested)}`);
    }
  }
}

/**
 * Describe a raw usage payload's **structure**, for a developer running the
 * app himself with `WALDER_DUMP_USAGE_SHAPE=1`.
 *
 * One line per top-level key naming its JSON type, then — for the keys in
 * `SHAPE_DETAIL_KEYS` only — one line per nested field with its numeric or
 * boolean value, arrays enumerated by index. No string value ever appears
 * (see `shapeValue`), so the output is safe to paste into a build log, which
 * is the entire reason it exists: it is how one real payload confirms or
 * corrects a parser written against guessed field names, without anybody
 * having to hand a raw dump around. It has already earned itself once — the
 * 2026-09-10 dump is what showed that `limits[]` keys per-model rows off
 * `scope.model.display_name` and that `extra_usage.used_credits` is in minor
 * units, both of which the guessed parsers had wrong.
 *
 * Pure, and returns lines rather than logging them: the caller decides whether
 * the flag is set, whether the build is packaged, and whether verbose logging
 * is on. This function does not know it is a diagnostic.
 */
export function usageShapeLines(json: unknown): string[] {
  if (!isRecord(json)) return [`(payload is ${shapeType(json)}, not an object)`];

  const out: string[] = [];
  for (const [key, value] of Object.entries(json)) {
    const name = spaceKey(key);
    out.push(`${name}: ${shapeType(value)}`);
    if (!SHAPE_DETAIL_KEYS.has(key)) continue;
    // Only a container has anything to open. A detail key whose value is a
    // scalar has already been fully described by the type line above, and
    // adding `seven day opus = null` under `seven day opus: null` said the same
    // thing twice — which the confirmed payload turned from a curiosity into
    // five wasted lines, since most of its `seven_day_…` keys are `null`.
    if (isRecord(value) || Array.isArray(value)) walkShape(name, value, 1, out);
  }
  return out;
}
