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
import type { ServiceName } from './services';
import { t } from './strings';
import { displayLabel } from './display-text';

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

/**
 * The tool's name as it appears in a bubble — and, since the SESSIONS block,
 * on the hover card. Exported so `card-layout.ts` names the two tools with the
 * same two strings the bubbles use rather than a second pair that can drift.
 */
export const SOURCE_LABEL: Readonly<Record<HookSource, string>> = {
  claude: t('bubble.sourceLabel.claude'),
  codex: t('bubble.sourceLabel.codex')
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
  return t('bubble.hookDone', { tool: SOURCE_LABEL[source] });
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
  return t('bubble.hookWaiting', { tool: SOURCE_LABEL[source] });
}

/**
 * The hooks are not installed at all, so the dog can never react to Claude
 * Code. Said once per launch, as a notice — see `Behaviour.onNotice`.
 *
 * Phrased as the action rather than the symptom ("Claude Code hooks missing"):
 * the tray item it points at is called *Install Claude Code hooks…*, and a
 * bubble beside a dog has room for exactly one of the two.
 */
export const HOOKS_MISSING_TEXT = t('bubble.hooksMissing');

/**
 * The hooks are installed, but for a port nothing is listening on — the
 * listener walked to `hookPort + 1` at some launch after they were written, so
 * every hook since has posted into a closed door.
 */
export const HOOKS_STALE_TEXT = t('bubble.hooksStale');

/**
 * The same two for Codex, which has its own file (`~/.codex/hooks.json`) and its
 * own tray items — so one notice cannot stand for both, and a bubble that said
 * only "Install hooks" would send the owner to the wrong menu item half the
 * time. Shorter than the Claude pair because the tool's name is one word.
 */
export const CODEX_HOOKS_MISSING_TEXT = t('bubble.codexHooksMissing');

export const CODEX_HOOKS_STALE_TEXT = t('bubble.codexHooksStale');

/**
 * Claude Code's own keychain item has been emptied by a logout — distinct from
 * the hooks notices above, and from a plain `auth-needed` card, because there is
 * nothing Walder or a renewal attempt can do about it: only the owner running
 * `claude` and logging in again fixes this. Said once per logout episode, as a
 * notice — see `Behaviour.onNotice`.
 */
export const CLAUDE_LOGGED_OUT_TEXT = t('bubble.claudeLoggedOut');

/**
 * *Report a bug…* has just put the diagnostics block on the clipboard,
 * replacing whatever the owner had copied there. The issue form says so, but a
 * browser that is not signed in to GitHub never shows the form (2026-11-13), so
 * the dog says it, as a notice — see `Behaviour.onNotice`.
 */
export const BUG_REPORT_COPIED_TEXT = t('bubble.bugReportCopied');

/**
 * First launch, beat one: where the app actually is.
 *
 * Walder has no dock icon, no window and no onboarding — until 0.2.6 a first
 * run was a dog appearing in the corner with a confused face and no way to find
 * out what he wanted. This says the one thing nothing else on the screen does:
 * the menu bar is the app, and the bone is the icon.
 */
export const INTRO_HELLO_TEXT = t('bubble.introHello');

/**
 * `INTRO_HELLO_TEXT` for the OS Walder runs on: only macOS has a menu bar; on
 * Windows (and anything else) the bone sits in the tray (2026-11-13). Never
 * longer than the Mac sentence, so it stays inside every width bound that one
 * already proves.
 */
export function introHelloText(platform: string): string {
  return t(platform === 'darwin' ? 'bubble.introHello' : 'bubble.introHelloTray');
}

/**
 * First launch, beat two: the exact path to a login, shown only when there is
 * no usage to show.
 *
 * The menu path verbatim rather than "log in to Claude", because the confused
 * face is already up by the time this appears — there is no number yet, and
 * that is precisely the state this beat exists to explain.
 */
export const INTRO_LOGIN_TEXT = t('bubble.introLogin');

/**
 * Petting a sleeping dog. Not words: he is asleep, and a sentence would read as
 * him waking up, which is precisely what he must not do.
 */
export const SLEEP_TEXT = t('bubble.sleep');

/** One character, so it costs a single monospace column. */
export const ELLIPSIS = t('bubble.ellipsis');

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
  return t('bubble.update', { version });
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
  service: ServiceName;
  key: string;
  label: string;
  kind?: string;
}): string {
  if (bucket.service === 'claude') {
    if (bucket.key === CLAUDE_FIVE_HOUR_KEY) return t('bubble.barkLabel.claudeFiveHour');
    if (bucket.key === CLAUDE_SEVEN_DAY_KEY) return t('bubble.barkLabel.claudeSevenDay');
    if (bucket.key === EXTRA_USAGE_KEY) return t('bubble.barkLabel.claudeCredits');
    // Every per-model weekly row, and only those: the pool is already gone.
    if (bucket.label.startsWith(LIMIT_LABEL_PREFIX)) {
      const model = bucket.label.slice(LIMIT_LABEL_PREFIX.length).trim();
      if (model.length > 0) return t('bubble.barkLabel.modelWeekly', { model });
    }
    return displayLabel(bucket.label);
  }
  return bucket.label === CODEX_FIVE_HOUR_LABEL
    ? t('bubble.barkLabel.codexFiveHour')
    : displayLabel(bucket.label);
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
  return t('bubble.nudge', { label, pct: shown });
}

/**
 * Grapheme clusters: what a reader sees as one character. A Devanagari syllable
 * with its marks, an emoji with its modifiers and a base letter with a
 * combining accent are each one cluster, and a line is never cut inside one.
 */
const SEGMENTER =
  typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function graphemes(text: string): string[] {
  if (SEGMENTER === null) return Array.from(text);
  return Array.from(SEGMENTER.segment(text), (part) => part.segment);
}

/**
 * East Asian wide and fullwidth characters (Han, kana, Hangul, fullwidth
 * punctuation): two columns of a monospace face. Ranges rather than the Unicode
 * East_Asian_Width property, which no regular expression escape exposes.
 */
const WIDE =
  /^[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u;
/** Directional marks and isolates, and zero-width characters: no advance. */
const ZERO = /^[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]+$/u;

function clusterColumns(cluster: string): number {
  if (ZERO.test(cluster)) return 0;
  return WIDE.test(cluster) ? 2 : 1;
}

/**
 * How many monospace columns `text` takes: one per grapheme cluster, two for a
 * wide (Han) one, none for a directional isolate or mark. The unit the bubble's
 * wrap and the window's widening both count in, so that a Chinese sentence is
 * not predicted at half its width and a Hindi one not at twice its width.
 */
export function displayColumns(text: string): number {
  let columns = 0;
  for (const cluster of graphemes(text)) columns += clusterColumns(cluster);
  return columns;
}

/** True when `word` has a wide character, so it may be broken between any two of them. */
function hasWide(word: string): boolean {
  return graphemes(word).some((cluster) => WIDE.test(cluster));
}

/**
 * Where a word with Han in it may break: between any two wide clusters, and on
 * either side of a run of narrow ones, but never inside that run, so `Claude`
 * in `Claude已完成` stays whole. A word without a wide cluster is one piece.
 */
function pieces(word: string): string[] {
  const out: string[] = [];
  let inNarrowRun = false;
  for (const cluster of graphemes(word)) {
    const wide = WIDE.test(cluster);
    if (!wide && inNarrowRun) out[out.length - 1] += cluster;
    else out.push(cluster);
    inNarrowRun = !wide;
  }
  return out;
}

/** The longest leading run of `pieces(text)` that fits `cols` columns, and the rest; `''` when none fits. */
function splitAtPieces(text: string, cols: number): [string, string] {
  const parts = pieces(text);
  let used = 0;
  let index = 0;
  while (index < parts.length) {
    const width = displayColumns(parts[index] as string);
    if (used + width > cols) break;
    used += width;
    index++;
  }
  return [parts.slice(0, index).join(''), parts.slice(index).join('')];
}

/**
 * The longest leading part of `text` that fits `cols` columns, and the rest.
 * Cuts between grapheme clusters, never inside one; always takes at least one
 * cluster so a split always makes progress.
 */
function splitAtColumns(text: string, cols: number): [string, string] {
  const clusters = graphemes(text);
  let used = 0;
  let index = 0;
  while (index < clusters.length) {
    const width = clusterColumns(clusters[index] as string);
    if (index > 0 && used + width > cols) break;
    used += width;
    index++;
  }
  return [clusters.slice(0, index).join(''), clusters.slice(index).join('')];
}

/** Where a line may break: any whitespace except the no-break spaces (`95 %`, `Claude 5 h :`). */
const BREAKABLE = /[^\S  ]+/u;

/**
 * Break `text` into at most `maxLines` lines of at most `maxChars` columns,
 * ellipsising what does not fit.
 *
 * Greedy word wrap, with two deliberate details:
 *  - a single word longer than a line is hard-split rather than allowed to
 *    overflow, because the bubble is drawn inside a window that cannot grow —
 *    which is also how an unspaced Chinese sentence wraps by character;
 *  - when the text does not fit at all, the *last kept* line is truncated with a
 *    one-column ellipsis, so the reader can see that something was cut.
 *
 * Columns are `displayColumns`, and splits fall between grapheme clusters.
 * Words are separated at `BREAKABLE` spaces only, so a no-break space keeps
 * `95 %` and `5 h :` on one line.
 *
 * Returns `[]` for empty input — the caller draws no bubble at all then, rather
 * than an empty box.
 */
export function wrapBubbleText(text: string, maxChars: number, maxLines: number): string[] {
  const cols = Math.max(1, Math.floor(maxChars));
  const rows = Math.max(1, Math.floor(maxLines));

  const words = text.trim().split(BREAKABLE).filter((word) => word.length > 0);
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
    // A word that cannot fit on a line of its own: chop it at the column edge,
    // after whatever the current line still has room for.
    while (displayColumns(rest) > cols) {
      const room = current.length === 0 ? cols : cols - displayColumns(current) - 1;
      if (room > 0 && hasWide(rest)) {
        const [head, tail] = splitAtPieces(rest, room);
        if (head.length > 0) {
          current = current.length === 0 ? head : `${current} ${head}`;
          flush();
          rest = tail;
          continue;
        }
      }
      flush();
      // A narrow run longer than a whole line is the one thing still cut by column.
      const [whole, after] = hasWide(rest) ? splitAtPieces(rest, cols) : ['', rest];
      const [head, tail] = whole.length > 0 ? [whole, after] : splitAtColumns(rest, cols);
      lines.push(head);
      rest = tail;
    }
    if (rest.length === 0) continue;
    if (current.length === 0) current = rest;
    else if (displayColumns(current) + 1 + displayColumns(rest) <= cols) current = `${current} ${rest}`;
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
  const body = displayColumns(line) > cols - 1 ? splitAtColumns(line, cols - 1)[0] : line;
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
  const words = trimmed.split(BREAKABLE).filter((word) => word.length > 0);
  // No line can be narrower than the longest word without splitting it, and a
  // split word is as unreadable as an ellipsised one. A word with Han in it is
  // the exception: Chinese has no spaces and breaks between any two characters,
  // though never inside a Latin name it holds (`pieces`).
  const longestWord = words.reduce(
    (most, word) => Math.max(most, ...pieces(word).map(displayColumns)),
    1
  );
  const total = displayColumns(trimmed);

  for (let cols = longestWord; cols < total; cols++) {
    const lines = wrapBubbleText(trimmed, cols, rows);
    if (lines.length <= rows && !lines.some((line) => line.endsWith(ELLIPSIS))) return cols;
  }
  // Everything on one line always fits.
  return total;
}

/** A grapheme cluster with Devanagari in it (Hindi): drawn from a fallback face, not the monospace one. */
const DEVANAGARI = /[ऀ-ॿ꣠-ꣿ]/u;

/**
 * Columns' worth of width a Devanagari cluster takes, in `M`s of the bubble face.
 *
 * Mac QA 2026-11-19: the Hindi up-to-date notice wrapped to two lines at
 * Small; any Hindi line drawn wider than its column count can. The
 * monospace stacks have no Devanagari, so it comes from a fallback face, and
 * `layoutBubble` divides the *measured* line by `displayColumns` for its column
 * width. Measured in Electron 45 on macOS (canvas, `BUBBLE_FONT_STACK`, 12 to
 * 16 px): a Hindi sentence's clusters average 1.0 to 1.3 `M` each, one syllable
 * alone up to 1.73. The window was widened for 1.0. 1.5 is generous on purpose:
 * spare width is transparent, a column short is a wrapped line, and Windows'
 * fallback face (Nirmala UI) was not measured.
 */
export const DEVANAGARI_COLUMN_WEIGHT = 1.5;

/**
 * The columns to widen the window by for `text` in `maxLines`: what
 * `bubbleColumnsNeeded` asks for, scaled up when the text holds Devanagari by
 * how much wider than its count it is drawn. What `main/behaviour.ts` sends to
 * `bubbleExtraPx`; the same as `bubbleColumnsNeeded` for every other script.
 */
export function bubbleReserveColumns(text: string, maxLines = 2): number {
  const columns = bubbleColumnsNeeded(text, maxLines);
  if (columns === 0) return 0;
  let counted = 0;
  let drawn = 0;
  for (const cluster of graphemes(text.trim())) {
    const width = clusterColumns(cluster);
    counted += width;
    drawn += DEVANAGARI.test(cluster) ? width * DEVANAGARI_COLUMN_WEIGHT : width;
  }
  return counted === 0 ? columns : Math.ceil((columns * drawn) / counted);
}
