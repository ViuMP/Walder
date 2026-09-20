/**
 * The keyboard shortcut that hides and un-hides Walder: which combinations are
 * offered, what they are called on screen, and whether a stored one is usable.
 *
 * Pure and Electron-free, so the whole vetted table and every label is pinned by
 * unit tests. `main/shortcut.ts` is the half that talks to `globalShortcut`.
 *
 * ## Why a fixed list rather than a recorder
 *
 * The owner chose presets (2026-09-09). A "press the keys you want" window is
 * the obvious design and the wrong one here: Walder has no window to put it in,
 * and — worse — nothing in Electron can tell whether a combination is already
 * taken by another app, by the OS, or by the keyboard layout. A recorder would
 * happily accept `Cmd+Q` or a combination that types `@` on a Danish keyboard,
 * and the owner would have no way to tell "the shortcut is broken" from "Walder
 * is broken". A short list of combinations somebody has actually checked is
 * worth more than an unlimited one nobody has.
 *
 * ## The rules the list obeys
 *
 * Each preset carries a `darwin` accelerator *and* an `other` one, because
 * `Command` does not exist off macOS and `Control+Alt` is `AltGr` on the Danish
 * layout the owner uses — so a single string per preset would eventually be sent
 * to the platform it is wrong for. Two absolute exclusions:
 *
 *  - **No `Super`/`Win` anywhere.** Electron documents the modifier and
 *    `globalShortcut.register` does not honour it on Windows (electron#9206,
 *    #4319, #45676): it returns `false`, or fails with "conversion failure from
 *    Super". That is what ruled out the owner's original `Ctrl+Win+W`.
 *  - **No `Control+Alt+…` off macOS.** It *is* `AltGr` on a Danish keyboard, so
 *    the shortcut would fire while the owner typed `@`, `£`, `{`, `}` or `€`.
 *
 * ## The defaults (the owner's decision, 2026-09-09)
 *
 * macOS `Control+Command+W`: the ⌃⌘ space is nearly empty (only D, F, Q, Space
 * and H-as-Hide are spoken for), and macOS registers global shortcuts through
 * Carbon rather than the accessibility API, so no permission dialog appears.
 *
 * Windows `Alt+Shift+W`, chosen knowing that `Alt+Shift` is Windows' own
 * input-language switch — on a machine with one keyboard layout that switch does
 * nothing, and the owner preferred a letter he could remember to a function key.
 * `Shift+F9` and `Control+Shift+F12` are in the list as the collision-free
 * alternatives, and the README says so.
 */
import { t } from './strings';

/**
 * One offered combination. `id` is stable and platform-independent, so a stored
 * preference is a *string accelerator* rather than an index into this table —
 * the table can be reordered without silently changing anybody's shortcut.
 */
export interface ShortcutPreset {
  readonly id: string;
  /** The accelerator on macOS. */
  readonly darwin: string;
  /** The accelerator everywhere else. */
  readonly other: string;
  /**
   * A word of warning for the menu, or `undefined` for a clean one. Short: it
   * is appended to a menu label, not a paragraph.
   */
  readonly caveat?: string;
}

/** macOS's default, and the one the ⌃⌘ space was checked for. */
export const DEFAULT_HIDE_SHORTCUT_DARWIN = 'Control+Command+W';
/** Everywhere else. See the header for why it is not a `Win` combination. */
export const DEFAULT_HIDE_SHORTCUT_OTHER = 'Alt+Shift+W';

/**
 * The offered combinations, in menu order.
 *
 * Eight entries, which is as many as a submenu can hold before it stops being a
 * list and starts being a problem. The first is the platform default. Every one
 * of them was checked against the macOS system shortcut list and against
 * Windows' own; the notes are in `docs/BUILD_LOG.md`.
 *
 * Note that on Windows the first and fourth entries are the same combination —
 * the default *is* `Alt+Shift+W` there. `shortcutPresetsFor` drops the
 * duplicate, so the radio group never shows one accelerator twice.
 */
export const SHORTCUT_PRESETS: readonly ShortcutPreset[] = [
  {
    id: 'default',
    darwin: DEFAULT_HIDE_SHORTCUT_DARWIN,
    other: DEFAULT_HIDE_SHORTCUT_OTHER
  },
  { id: 'shift-f9', darwin: 'Shift+F9', other: 'Shift+F9' },
  { id: 'ctrl-shift-f12', darwin: 'Control+Shift+F12', other: 'Control+Shift+F12' },
  {
    id: 'alt-shift-w',
    darwin: 'Alt+Shift+W',
    other: 'Alt+Shift+W',
    // ⌥⇧W types a ring accent on a Danish Mac keyboard, and Alt+Shift is the
    // input-language switch on Windows. Offered because the owner asked for it;
    // labelled because he should not have to rediscover why it misbehaves.
    caveat: t('shortcuts.caveatAccents')
  },
  {
    id: 'alt-shift-h',
    darwin: 'Alt+Shift+H',
    other: 'Alt+Shift+H',
    caveat: t('shortcuts.caveatAccents')
  },
  { id: 'ctrl-shift-f11', darwin: 'Control+Shift+F11', other: 'Control+Shift+F11' },
  { id: 'shift-f8', darwin: 'Shift+F8', other: 'Shift+F8' },
  { id: 'shift-f10', darwin: 'Shift+F10', other: 'Shift+F10' }
];

/** Is this the macOS accelerator vocabulary? */
function isDarwin(platform: string): boolean {
  return platform === 'darwin';
}

/** The accelerator this preset means on `platform`. */
export function presetAccelerator(preset: ShortcutPreset, platform: string): string {
  return isDarwin(platform) ? preset.darwin : preset.other;
}

/** The default shortcut for a platform. */
export function defaultHideShortcut(platform: string): string {
  return isDarwin(platform) ? DEFAULT_HIDE_SHORTCUT_DARWIN : DEFAULT_HIDE_SHORTCUT_OTHER;
}

/**
 * The presets to offer on `platform`, with duplicate accelerators removed.
 *
 * Only ever removes anything on Windows and Linux, where the default preset and
 * the explicit `Alt+Shift+W` one resolve to the same keys. Two radio items
 * carrying one accelerator would both show a dot, and clicking either would
 * appear to do nothing.
 */
export function shortcutPresetsFor(platform: string): readonly ShortcutPreset[] {
  const seen = new Set<string>();
  return SHORTCUT_PRESETS.filter((preset) => {
    const accelerator = presetAccelerator(preset, platform);
    if (seen.has(accelerator)) return false;
    seen.add(accelerator);
    return true;
  });
}

/** Modifier tokens Electron understands, and what each is called on screen. */
const MODIFIER_GLYPHS: Readonly<Record<string, string>> = {
  command: '⌘',
  cmd: '⌘',
  commandorcontrol: '⌘',
  cmdorctrl: '⌘',
  control: '⌃',
  ctrl: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧'
};

/** The same tokens as words, for a platform with no glyph convention. */
const MODIFIER_WORDS: Readonly<Record<string, string>> = {
  command: 'Cmd',
  cmd: 'Cmd',
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift'
};

/**
 * The order macOS prints modifiers in: ⌃⌥⇧⌘, always, whatever order they were
 * written in. A menu that showed ⌘⌃W would look like a typo to anyone who has
 * used a Mac.
 */
const DARWIN_GLYPH_ORDER: readonly string[] = ['⌃', '⌥', '⇧', '⌘'];

/**
 * Named keys an accelerator may end with, beyond a single character.
 *
 * A closed list, because this doubles as the validator for a stored value (see
 * `looksLikeAccelerator`) and a typo that reaches `globalShortcut.register`
 * throws. Deliberately excludes `Super` — see the header.
 */
const NAMED_KEYS: readonly string[] = [
  'space',
  'tab',
  'backspace',
  'delete',
  'insert',
  'return',
  'enter',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'escape',
  'esc',
  'plus',
  ...Array.from({ length: 24 }, (_unused, index) => `f${index + 1}`)
];

/** How the key at the end of an accelerator is printed. */
function keyLabel(token: string): string {
  if (token.length === 1) return token.toUpperCase();
  const lower = token.toLowerCase();
  if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * The shortcut as the owner should read it: `⌃⌘W` on a Mac, `Alt+Shift+W`
 * elsewhere.
 *
 * Glyphs on macOS because that is what every other menu on the machine shows,
 * and words elsewhere for the same reason. An accelerator this cannot make sense
 * of is returned unchanged rather than mangled — the menu then shows something
 * odd, which is a better failure than a label that is confidently wrong.
 */
export function shortcutLabel(accelerator: string, platform: string): string {
  const tokens = accelerator.split('+').map((token) => token.trim()).filter((t) => t.length > 0);
  if (tokens.length === 0) return accelerator;

  const key = tokens[tokens.length - 1] as string;
  const modifiers = tokens.slice(0, -1).map((token) => token.toLowerCase());

  if (isDarwin(platform)) {
    const glyphs = modifiers.map((token) => MODIFIER_GLYPHS[token]);
    if (glyphs.some((glyph) => glyph === undefined)) return accelerator;
    const ordered = DARWIN_GLYPH_ORDER.filter((glyph) => glyphs.includes(glyph));
    return `${ordered.join('')}${keyLabel(key)}`;
  }

  const words = modifiers.map((token) => MODIFIER_WORDS[token]);
  if (words.some((word) => word === undefined)) return accelerator;
  return [...words, keyLabel(key)].join('+');
}

/** Longest accelerator worth considering. Well past `Control+Alt+Shift+F12`. */
const MAX_ACCELERATOR_LENGTH = 64;

/**
 * Could this string be handed to `globalShortcut.register`?
 *
 * The settings file is user-writable and `clearInvalidConfig` wipes *everything*
 * on a schema failure, so the shortcut is deliberately unconstrained in the
 * JSON schema and validated here instead — a hand-mangled shortcut must cost
 * the owner his shortcut, not his position memory and his coat choice. See
 * `readHideShortcut` in `store.ts`.
 *
 * `Super`, `Win` and `Meta` are rejected along with the nonsense: they are
 * broken in Electron on Windows, so a stored one would register nothing and the
 * owner would be left with no shortcut and no explanation. Falling back to the
 * platform default is the better answer.
 */
export function looksLikeAccelerator(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ACCELERATOR_LENGTH) return false;

  const tokens = trimmed.split('+');
  if (tokens.length < 1) return false;
  if (tokens.some((token) => token.trim().length === 0)) return false;

  const key = (tokens[tokens.length - 1] as string).trim().toLowerCase();
  const modifiers = tokens.slice(0, -1).map((token) => token.trim().toLowerCase());

  // A bare key with no modifier would swallow that key everywhere on the
  // machine, which is not a shortcut but a fault.
  if (modifiers.length === 0) return false;
  if (modifiers.some((token) => MODIFIER_WORDS[token] === undefined)) return false;
  // No repeats: `Shift+Shift+W` is not something to hand to the OS.
  if (new Set(modifiers).size !== modifiers.length) return false;

  if (key.length === 1) return /^[a-z0-9]$/.test(key);
  return NAMED_KEYS.includes(key);
}

/**
 * What became of the attempt to register the shortcut.
 *
 * `in-use` is the one that matters to the owner: the setting is *kept* (so
 * quitting whatever took the keys makes it work again on the next launch), and
 * the menu says so rather than showing a shortcut that does nothing.
 */
export type ShortcutStatus = 'registered' | 'in-use' | 'invalid' | 'unregistered';

/**
 * The disabled line under the shortcut list, or `null` when there is nothing to
 * report.
 *
 * Nothing at all when it worked — a menu that congratulates itself on a working
 * shortcut is noise. Plain English otherwise, and it names the keys, because the
 * owner reads this line while wondering why pressing them did nothing.
 */
export function shortcutStatusLine(
  status: ShortcutStatus,
  accelerator: string,
  platform: string
): string | null {
  if (status === 'registered') return null;
  const label = shortcutLabel(accelerator, platform);
  switch (status) {
    case 'in-use':
      return `${label} is already used by another app`;
    case 'invalid':
      return `${label} is not a shortcut Walder can use`;
    case 'unregistered':
    default:
      return `${label} is not switched on`;
  }
}
