/**
 * Speech-bubble text: what it says, and how it is broken across lines.
 *
 * Pure and DOM-free so the wording is pinned by unit tests rather than by
 * whatever the renderer happens to draw. The *measuring* stays in the renderer —
 * only it knows the font metrics — so this module takes a column count and a
 * line count and does the arithmetic.
 */
import {
  CLAUDE_FIVE_HOUR_KEY,
  CLAUDE_SEVEN_DAY_KEY,
  CODEX_FIVE_HOUR_LABEL,
  EXTRA_USAGE_KEY,
  LIMIT_LABEL_PREFIX
} from './buckets';

/**
 * Which kind of thing the bubble is saying. `none` means "clear it".
 *
 * `sleepy` is the one kind that appears *while Walder stays asleep* — the
 * acknowledgement a pet earns from a curled-up dog — and the behaviour
 * coordinator treats it differently for exactly that reason (see `settle`).
 * `update` is the once-per-version notice that a newer Walder exists; it is a
 * bubble rather than a dialog because Walder has no window to put a dialog in,
 * and it queues *behind* everything else because it is the least urgent thing
 * he ever says.
 */
export type BubbleKind = 'nudge' | 'perk' | 'waiting' | 'sleepy' | 'update' | 'none';

/** The sleeping acknowledgement thinks; every other message is spoken. */
export function bubbleShape(kind: BubbleKind): 'speech' | 'thought' {
  return kind === 'sleepy' ? 'thought' : 'speech';
}

/**
 * Which coding tool a hook came from.
 *
 * Declared here rather than beside the listener that detects it, for the same
 * reason `BubbleKind` is: `core/` may not import from `main/`, and this is the
 * vocabulary two pure things need — the texts below and the behaviour
 * coordinator's per-source queue. `main/hook-server.ts` imports and re-exports
 * it, so the wiring side has one name for it too.
 */
export type HookSource = 'claude' | 'codex';

/** The tool's name as it appears in a bubble. */
const SOURCE_LABEL: Readonly<Record<HookSource, string>> = {
  claude: 'Claude',
  codex: 'Codex'
};

/**
 * A perk: the tool finished a reply and Walder's ears went up.
 *
 * `woof` until 0.2.5, and the change is the owner's: he runs Claude Code and
 * Codex side by side, so a bubble that does not name the tool tells him a reply
 * is ready without telling him *whose* — which is the one thing he needed to
 * know. The word is gone rather than prefixed (`Claude woof`) because the
 * bark is already the dog's own voice; the bubble is the message.
 */
export function hookDoneText(source: HookSource): string {
  return `${SOURCE_LABEL[source]} done`;
}

/**
 * Waiting for input: `Claude waiting`, `Codex waiting`.
 *
 * A bare `?` until 0.2.5 — chosen because the bubble has no time limit and a
 * sentence parked on screen for ten minutes reads as a stuck app. Two tools
 * made that untenable: a `?` says which *state* he is in and nothing about who
 * is waiting. The pixel `?` by his ear still carries the "stuck on screen is
 * fine" job (`BUBBLE_AS_DECOR`), and now draws *alongside* these words rather
 * than instead of them.
 */
export function hookWaitingText(source: HookSource): string {
  return `${SOURCE_LABEL[source]} waiting`;
}

/**
 * The hooks are not installed at all, so the dog can never react to Claude
 * Code. Said once per launch, as a notice — see `Behaviour.onNotice`.
 *
 * Phrased as the action rather than the symptom ("Claude Code hooks missing"):
 * the tray item it points at is called *Install Claude Code hooks…*, and a
 * bubble beside a dog has room for exactly one of the two.
 */
export const HOOKS_MISSING_TEXT = 'Install Claude Code hooks';

/**
 * The hooks are installed, but for a port nothing is listening on — the
 * listener walked to `hookPort + 1` at some launch after they were written, so
 * every hook since has posted into a closed door.
 */
export const HOOKS_STALE_TEXT = 'Reinstall Claude Code hooks';

/**
 * The same two for Codex, which has its own file (`~/.codex/hooks.json`) and its
 * own tray items — so one notice cannot stand for both, and a bubble that said
 * only "Install hooks" would send the owner to the wrong menu item half the
 * time. Shorter than the Claude pair because the tool's name is one word.
 */
export const CODEX_HOOKS_MISSING_TEXT = 'Install Codex hooks';

export const CODEX_HOOKS_STALE_TEXT = 'Reinstall Codex hooks';

/**
 * Petting a sleeping dog. Not words: he is asleep, and a sentence would read as
 * him waking up, which is precisely what he must not do.
 */
export const SLEEP_TEXT = '…zzz';

/** One character, so it costs a single monospace column. */
export const ELLIPSIS = '…';

/**
 * A newer Walder exists: `Walder 0.2.5 is out`.
 *
 * It said `0.2.5 is out` until 0.2.6, and the argument then was that four words
 * are all a bubble beside a 144-pixel dog can hold. That argument is
 * **superseded**: the window is now widened for a one-line fit of whatever the
 * sentence is (`bubbleExtraPx`, and the table in `test/geometry.test.ts`), so
 * one more word costs pixels nobody is short of. It buys the thing a bare
 * version number could not say — *which* app the number belongs to, on a screen
 * where Walder is one of several things that announce themselves.
 *
 * The *action* is still not in the bubble. The download lives in the menu
 * ("Update available: 0.2.5 — Download…"), which is where the owner can read it
 * at leisure; the dog's job is only to make him look at the menu once. Still
 * deliberately not "Update available" or "New version": the version number is
 * the thing he can check against the one he is running.
 */
export function updateText(version: string): string {
  return `Walder ${version} is out`;
}

/**
 * The name a row goes by **in a bubble** — which is not the name it goes by on
 * the hover card.
 *
 * The owner's decision (2026-09-15, the bubble book). The card is a table he is
 * reading on purpose, one row under another, under a heading that already says
 * CLAUDE or CHATGPT; a bubble is one line glanced at across a screen with no
 * heading and no neighbours, and `5-hour: 87% used` does not say *whose* 5-hour
 * window while he runs two tools side by side. So the bubble names the service
 * and drops the words the card's layout was carrying for it. **Card labels are
 * untouched** — this function is only ever called on the way into a bubble.
 *
 * Rule by rule, each one the owner's own:
 *
 *  - **`five_hour` → `Claude 5h`.** The service is the missing half; `5h` rather
 *    than `5-hour` because the row is about to be read beside `Codex 5h`, and
 *    the pair only reads as a pair if both are spelled the same way.
 *  - **`seven_day` → `Claude 7-day`.** `(all models)` was the card
 *    disambiguating the pool from the per-model rows *beneath* it. A bubble has
 *    no rows beneath it, and the parenthesis is a third of the line.
 *  - **a per-model weekly row → `<Model> weekly`** (`Fable weekly`,
 *    `Opus weekly`, `Sonnet weekly`). Every one of them wears
 *    `LIMIT_LABEL_PREFIX`, whichever route produced it — `CLAUDE_WINDOW_MAP`,
 *    the derived Fable mirror, or a `limits[]` entry carrying the dashboard's
 *    own display name — so the prefix is stripped and the model's name leads.
 *    It leads because the model is what the owner recognises: he runs Fable, and
 *    "Fable" is the word he is looking for. Tested against the pool above by
 *    key *first*, since `7-day (all models)` wears the prefix too.
 *  - **`extra_usage` → `Claude credits`.** The money row. `Extra usage` is
 *    claude.ai's own name for the *setting*; what the bubble is about is the
 *    spend, and `Claude credits` pairs it with `Codex credits` — the same fact
 *    on the other service, which already reads that way.
 *  - **the Codex 5-hour window → `Codex 5h`**, matched on the label because the
 *    key varies by payload route (see `CODEX_FIVE_HOUR_LABEL`). `Codex weekly`
 *    is already right and is left alone, as is every other Codex or ChatGPT
 *    label.
 *  - **`Codex credits` → `Codex credits`**, by falling through: it needs no rule,
 *    which is the point — it is the shape the other three were bent towards.
 *  - **anything else → the bucket's own label.** A window Anthropic or OpenAI
 *    adds tomorrow still barks, under whatever the parser called it.
 *
 * Takes a structural subset of `Bucket` rather than a `Bucket`, so a test can
 * state a row in four fields. `kind` is accepted because the money row is a
 * `kind: 'money'` one and a caller reading this signature should see that the
 * whole bucket fits — the *match* is on the key, which is what identifies the
 * row whether or not its money detail survived a restore from disk.
 */
export function barkLabel(bucket: {
  service: 'claude' | 'chatgpt';
  key: string;
  label: string;
  kind?: string;
}): string {
  if (bucket.service === 'claude') {
    if (bucket.key === CLAUDE_FIVE_HOUR_KEY) return 'Claude 5h';
    if (bucket.key === CLAUDE_SEVEN_DAY_KEY) return 'Claude 7-day';
    if (bucket.key === EXTRA_USAGE_KEY) return 'Claude credits';
    // Every per-model weekly row, and only those: the pool is already gone.
    if (bucket.label.startsWith(LIMIT_LABEL_PREFIX)) {
      const model = bucket.label.slice(LIMIT_LABEL_PREFIX.length).trim();
      if (model.length > 0) return `${model} weekly`;
    }
    return bucket.label;
  }
  return bucket.label === CODEX_FIVE_HOUR_LABEL ? 'Codex 5h' : bucket.label;
}

/**
 * A usage bark: `Claude 5h: 80% used`, `Claude 7-day: 85% used`,
 * `Codex 5h: 90% used`.
 *
 * The label is whatever the caller hands over — in practice `barkLabel(bucket)`,
 * applied where the snapshot meets the bark machine (`barkableBuckets`), so a
 * provider that renames or adds a window needs no change here. The percentage is
 * the *observed* one rounded to a whole number, not the threshold that fired:
 * telling the owner "80% used" when the reading is 87 % would understate the
 * thing he is being warned about.
 */
export function nudgeText(label: string, pct: number): string {
  const shown = Number.isFinite(pct) ? Math.round(pct) : 0;
  return `${label}: ${shown}% used`;
}

/**
 * Break `text` into at most `maxLines` lines of at most `maxChars` columns,
 * ellipsising what does not fit.
 *
 * Greedy word wrap, with two deliberate details:
 *  - a single word longer than a line is hard-split rather than allowed to
 *    overflow, because the bubble is drawn inside a window that cannot grow;
 *  - when the text does not fit at all, the *last kept* line is truncated with a
 *    one-column ellipsis, so the reader can see that something was cut.
 *
 * Returns `[]` for empty input — the caller draws no bubble at all then, rather
 * than an empty box.
 */
export function wrapBubbleText(text: string, maxChars: number, maxLines: number): string[] {
  const cols = Math.max(1, Math.floor(maxChars));
  const rows = Math.max(1, Math.floor(maxLines));

  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.length === 0) return;
    lines.push(current);
    current = '';
  };

  for (const word of words) {
    let rest = word;
    // A word that cannot fit on a line of its own: chop it at the column edge.
    while (rest.length > cols) {
      flush();
      lines.push(rest.slice(0, cols));
      rest = rest.slice(cols);
    }
    if (rest.length === 0) continue;
    if (current.length === 0) current = rest;
    else if (current.length + 1 + rest.length <= cols) current = `${current} ${rest}`;
    else {
      flush();
      current = rest;
    }
  }
  flush();

  if (lines.length <= rows) return lines;

  const kept = lines.slice(0, rows);
  kept[rows - 1] = ellipsise(kept[rows - 1] as string, cols);
  return kept;
}

/** Trim a line to `cols` columns with the last column spent on the ellipsis. */
function ellipsise(line: string, cols: number): string {
  if (cols <= 1) return ELLIPSIS;
  const body = line.length > cols - 1 ? line.slice(0, cols - 1) : line;
  return `${body.replace(/\s+$/u, '')}${ELLIPSIS}`;
}

/**
 * How many columns `text` needs to fit in `maxLines` without being cut.
 *
 * The window cannot grow on demand once created, so its width is chosen up
 * front — and at the small size (1 sprite pixel = 1 logical pixel) the standing
 * box is only 64 px wide, which is about 14 monospace columns. `5-hour: 85%
 * used` fits in two lines of that; `7-day (all models): 85% used` does not, and
 * arrived ellipsised as `7-day (all mod…`, which names no window and no number.
 * So the window is widened for the bubble instead (`bubbleExtraPx`), and this is
 * the column count that widening is computed from.
 *
 * Found by search rather than arithmetic, because the wrap is greedy and words
 * are never split when they can be avoided: `ceil(length / maxLines)` is wrong
 * in both directions for real text. The search is over at most `text.length`
 * candidates of a string that is a few dozen characters, once per bubble.
 *
 * Returns `0` for empty text — there is no bubble to make room for.
 */
export function bubbleColumnsNeeded(text: string, maxLines = 2): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;

  const rows = Math.max(1, Math.floor(maxLines));
  const words = trimmed.split(/\s+/u).filter((word) => word.length > 0);
  // No line can be narrower than the longest word without splitting it, and a
  // split word is as unreadable as an ellipsised one.
  const longestWord = words.reduce((most, word) => Math.max(most, word.length), 1);

  for (let cols = longestWord; cols < trimmed.length; cols++) {
    const lines = wrapBubbleText(trimmed, cols, rows);
    if (lines.length <= rows && !lines.some((line) => line.endsWith(ELLIPSIS))) return cols;
  }
  // Everything on one line always fits.
  return trimmed.length;
}
