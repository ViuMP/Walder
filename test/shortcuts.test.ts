/**
 * The vetted shortcut table, its labels and its validator.
 *
 * The point of pinning this in a test is that every value in
 * `core/shortcuts.ts` is a *research result* rather than a preference — which
 * combinations Windows' own shell has taken, which ones the Danish keyboard
 * layout eats, which modifier Electron cannot actually register. None of that
 * is visible from the code, and all of it is one careless edit away from being
 * lost. So the two absolute rules get their own cases, by name.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HIDE_SHORTCUT_DARWIN,
  DEFAULT_HIDE_SHORTCUT_OTHER,
  SHORTCUT_PRESETS,
  defaultHideShortcut,
  looksLikeAccelerator,
  presetAccelerator,
  shortcutLabel,
  shortcutPresetsFor,
  shortcutStatusLine
} from '../src/core/shortcuts';

const PLATFORMS = ['darwin', 'win32', 'linux'] as const;

/** Every accelerator the table can produce, on every platform. */
function allAccelerators(): string[] {
  return PLATFORMS.flatMap((platform) =>
    SHORTCUT_PRESETS.map((preset) => presetAccelerator(preset, platform))
  );
}

describe('the defaults (the owner decided these on 2026-09-09)', () => {
  it('is Control+Command+W on macOS', () => {
    expect(defaultHideShortcut('darwin')).toBe('Control+Command+W');
    expect(DEFAULT_HIDE_SHORTCUT_DARWIN).toBe('Control+Command+W');
  });

  it('is Alt+Shift+W everywhere else, not a Win combination', () => {
    // The owner's original choice was Ctrl+Win+W; Electron cannot register a
    // `Super` combination on Windows, so he picked this instead knowing that
    // Alt+Shift is the input-language switch there. README says so in one line.
    expect(defaultHideShortcut('win32')).toBe('Alt+Shift+W');
    expect(defaultHideShortcut('linux')).toBe('Alt+Shift+W');
    expect(DEFAULT_HIDE_SHORTCUT_OTHER).toBe('Alt+Shift+W');
  });

  it('offers the platform default as the first preset', () => {
    for (const platform of PLATFORMS) {
      const first = shortcutPresetsFor(platform)[0];
      expect(first).toBeDefined();
      expect(presetAccelerator(first as never, platform)).toBe(defaultHideShortcut(platform));
    }
  });
});

describe('the preset table', () => {
  it('is short enough to be a list rather than a problem', () => {
    expect(SHORTCUT_PRESETS.length).toBeLessThanOrEqual(8);
    expect(SHORTCUT_PRESETS.length).toBeGreaterThan(2);
  });

  it('never mentions Super, on any platform', () => {
    // `globalShortcut.register` does not honour it on Windows (electron#9206,
    // #4319, #45676) — and a smoke test on the build Mac found that
    // `Control+Super+W` is refused on macOS too.
    for (const accelerator of allAccelerators()) {
      expect(accelerator).not.toMatch(/super|win|meta/i);
    }
  });

  it('never sends Command to a platform that has none, or Control+Alt to Windows', () => {
    for (const preset of SHORTCUT_PRESETS) {
      expect(preset.other).not.toMatch(/command|cmd/i);
      // Control+Alt is AltGr on a Danish keyboard: the shortcut would fire while
      // the owner typed @ £ { } €.
      expect(preset.other).not.toMatch(/control\+alt|ctrl\+alt|alt\+control|alt\+ctrl/i);
    }
  });

  it('has a unique id per preset and a usable accelerator everywhere', () => {
    const ids = SHORTCUT_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const accelerator of allAccelerators()) {
      expect(looksLikeAccelerator(accelerator), accelerator).toBe(true);
    }
  });

  it('shows no accelerator twice in the menu', () => {
    // On Windows the default preset and the explicit Alt+Shift+W one are the
    // same keys; two radio items carrying one accelerator would both show a dot.
    for (const platform of PLATFORMS) {
      const offered = shortcutPresetsFor(platform).map((preset) =>
        presetAccelerator(preset, platform)
      );
      expect(new Set(offered).size).toBe(offered.length);
    }
    expect(shortcutPresetsFor('darwin')).toHaveLength(SHORTCUT_PRESETS.length);
    expect(shortcutPresetsFor('win32').length).toBeLessThan(SHORTCUT_PRESETS.length);
  });

  it('labels the two risky presets and leaves the safe ones clean', () => {
    const byId = new Map(SHORTCUT_PRESETS.map((preset) => [preset.id, preset]));
    expect(byId.get('alt-shift-w')?.caveat).toBeDefined();
    expect(byId.get('alt-shift-h')?.caveat).toBeDefined();
    expect(byId.get('shift-f9')?.caveat).toBeUndefined();
    expect(byId.get('ctrl-shift-f12')?.caveat).toBeUndefined();
  });
});

describe('shortcutLabel', () => {
  it('uses the Mac glyphs, in the order every other Mac menu uses', () => {
    expect(shortcutLabel('Control+Command+W', 'darwin')).toBe('⌃⌘W');
    // Written the other way round, printed the same way: ⌃⌥⇧⌘ is the order.
    expect(shortcutLabel('Command+Control+W', 'darwin')).toBe('⌃⌘W');
    expect(shortcutLabel('Alt+Shift+W', 'darwin')).toBe('⌥⇧W');
    expect(shortcutLabel('Control+Shift+F12', 'darwin')).toBe('⌃⇧F12');
    expect(shortcutLabel('Shift+F9', 'darwin')).toBe('⇧F9');
  });

  it('uses words elsewhere, with Control spelled the way Windows spells it', () => {
    expect(shortcutLabel('Alt+Shift+W', 'win32')).toBe('Alt+Shift+W');
    expect(shortcutLabel('Control+Shift+F12', 'win32')).toBe('Ctrl+Shift+F12');
    expect(shortcutLabel('Shift+F9', 'linux')).toBe('Shift+F9');
  });

  it('hands back anything it cannot read, rather than mangling it', () => {
    // The menu then shows something odd, which is a better failure than a label
    // that is confidently wrong about which keys to press.
    expect(shortcutLabel('Hyper+W', 'darwin')).toBe('Hyper+W');
    expect(shortcutLabel('', 'darwin')).toBe('');
  });
});

describe('looksLikeAccelerator', () => {
  it('accepts the shapes Electron accepts', () => {
    expect(looksLikeAccelerator('Control+Command+W')).toBe(true);
    expect(looksLikeAccelerator('Alt+Shift+W')).toBe(true);
    expect(looksLikeAccelerator('Shift+F9')).toBe(true);
    expect(looksLikeAccelerator('CommandOrControl+Shift+Space')).toBe(true);
    expect(looksLikeAccelerator('Control+Shift+1')).toBe(true);
  });

  it('rejects a bare key: that is not a shortcut but a broken keyboard', () => {
    expect(looksLikeAccelerator('W')).toBe(false);
    expect(looksLikeAccelerator('F9')).toBe(false);
  });

  it('rejects Super, so a stored one falls back to the platform default', () => {
    expect(looksLikeAccelerator('Super+W')).toBe(false);
    expect(looksLikeAccelerator('Control+Super+W')).toBe(false);
    expect(looksLikeAccelerator('Meta+W')).toBe(false);
  });

  it('rejects the things a hand-edited settings file produces', () => {
    expect(looksLikeAccelerator('')).toBe(false);
    expect(looksLikeAccelerator('   ')).toBe(false);
    expect(looksLikeAccelerator('Control+')).toBe(false);
    expect(looksLikeAccelerator('+W')).toBe(false);
    expect(looksLikeAccelerator('Control++W')).toBe(false);
    expect(looksLikeAccelerator('Shift+Shift+W')).toBe(false);
    expect(looksLikeAccelerator('Control+Nope')).toBe(false);
    expect(looksLikeAccelerator('Control+F99')).toBe(false);
    expect(looksLikeAccelerator(`Control+${'W'.repeat(200)}`)).toBe(false);
    expect(looksLikeAccelerator(null)).toBe(false);
    expect(looksLikeAccelerator(42)).toBe(false);
    expect(looksLikeAccelerator({ accelerator: 'Control+W' })).toBe(false);
  });
});

describe('shortcutStatusLine', () => {
  it('says nothing at all when the shortcut works', () => {
    // A menu that reports its own success is noise.
    expect(shortcutStatusLine('registered', 'Control+Command+W', 'darwin')).toBeNull();
  });

  it('names the keys, in plain English, when it does not', () => {
    expect(shortcutStatusLine('in-use', 'Control+Command+W', 'darwin')).toBe(
      '⌃⌘W is already used by another app'
    );
    expect(shortcutStatusLine('invalid', 'Control+Shift+F12', 'win32')).toBe(
      'Ctrl+Shift+F12 is not a shortcut Walder can use'
    );
    expect(shortcutStatusLine('unregistered', 'Shift+F9', 'win32')).toBe(
      'Shift+F9 is not switched on'
    );
  });

  it('has no jargon in any of its lines', () => {
    for (const status of ['in-use', 'invalid', 'unregistered'] as const) {
      const line = shortcutStatusLine(status, 'Shift+F9', 'win32') ?? '';
      expect(line).not.toMatch(/accelerator|globalShortcut|register\(|null|undefined/i);
    }
  });
});
