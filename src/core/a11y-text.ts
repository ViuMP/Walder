/**
 * The words a screen reader says about Walder.
 *
 * It is in `core/` for the same reason `card-layout.ts` is: both renderers are
 * untestable (vitest runs under node here, with no jsdom), so anything either of
 * them *decides* is a decision nobody can watch. A label is exactly the kind of
 * string that rots silently — nothing on screen changes when it goes wrong, and
 * the one person who would notice is the person who cannot see the dog. Here it
 * is a pure function with a test per expression.
 *
 * The second reason is that there are two surfaces and one dog. The canvas'
 * `aria-label` and the hover card's rows describe the same numbers, and a reader
 * moving between them should hear the same words for the same thing rather than
 * two paraphrases that drifted apart in two renderers.
 *
 * **One sentence per fact, and no more facts than there are.** The mood is
 * always known (`confused` is itself a mood). The percentage is only named when
 * there is one — `pctForFace` answers `null` whenever Claude's 5-hour window is
 * missing, and "0%" would be a lie about a number nobody has. The bubble is
 * appended verbatim: it is already a sentence written for a human, and
 * rephrasing it here would mean two versions of every bark.
 *
 * **Honest ceiling.** Nobody has verified that VoiceOver ever reaches this
 * window. The overlay is `focusable: false` and click-through, which is the
 * combination assistive technology is least likely to walk into, and no screen
 * reader has been run against a Walder build. The label is the half of the work
 * that can be done and proved from here; whether the OS reads it out is a
 * question for a machine with VoiceOver on. The hover panel is the better bet of
 * the two — it is an ordinary focusable window — which is why its rows get
 * labels as well rather than relying on the canvas alone.
 */
import type { Expression } from './expression';
import { SERVICE_LABELS, type CardRow, type CardSection } from './card-layout';

/**
 * The mood, as a word.
 *
 * Plain adjectives, because the label is read aloud in the middle of whatever
 * else the reader is saying: "Walder, worried." is a sentence, "Walder,
 * expression: worried (3 of 6)" is a data dump. The two ends of the scale are
 * phrased as what they mean rather than what they look like — `out` is not a
 * face, it is an allowance that has run out, and `confused` says *why* there is
 * no number in the sentence that would otherwise follow.
 */
const MOOD_WORDS: Readonly<Record<Expression, string>> = {
  happy: 'happy',
  neutral: 'fine',
  worried: 'worried',
  exhausted: 'exhausted',
  out: 'out of Claude time',
  confused: 'confused, no number to show'
};

/**
 * What the dog on screen is saying, in words.
 *
 * `fiveHourPct` is `pctForFace`'s answer — Claude's 5-hour window and nothing
 * else, which is the one allowance the face is a statement about. Rounded the
 * way the card rounds it (`formatPct`), by the same arithmetic rather than by
 * calling it: this module stays free of `usage.ts` so the label cannot be made
 * to depend on a snapshot, and `Math.round` is the whole of that function.
 */
export function dogLabel(
  expression: Expression,
  fiveHourPct: number | null,
  bubble: string | null
): string {
  let label = `Walder, ${MOOD_WORDS[expression]}.`;
  if (fiveHourPct !== null && Number.isFinite(fiveHourPct)) {
    label += ` Claude 5-hour ${Math.round(fiveHourPct)}% used.`;
  }
  if (bubble !== null && bubble.length > 0) label += ` ${bubble}`;
  return label;
}

/**
 * One row of the hover card, as a reader hears it.
 *
 * Commas rather than a rebuilt sentence: the row is four columns of a table and
 * the pauses are what make it parse as one. `pctText` is used exactly as the
 * card shows it, whatever the kind — `63%`, `1,240 left`, `123 / 500 kr.` — so
 * the spoken row and the drawn row cannot say different numbers.
 *
 * The bar is deliberately absent, because it *is* `pctText` drawn twenty times;
 * `panel.ts` hides it from the tree rather than describing it twice.
 */
export function rowLabel(row: CardRow): string {
  let label = `${row.label}, ${row.pctText}`;
  if (row.shared) label += ', shared pool';
  if (row.resetsText !== null) label += `, ${row.resetsText}`;
  return label;
}

/**
 * One service's section heading.
 *
 * The menu-bar name, not the card's shouted `CLAUDE`: a reader would spell out
 * capitals or say them louder, and neither is what the heading means. The status
 * line comes along when there is one, because it is the reason an otherwise
 * empty section exists.
 */
export function sectionLabel(section: CardSection): string {
  const name = SERVICE_LABELS[section.service];
  return section.statusLine === null ? name : `${name}, ${section.statusLine}`;
}
