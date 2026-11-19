/** Giving key focus back after a press on the dog (RECHECK 2026-11-18 c, Mac QA 2026-11-19). */
import { describe, expect, it } from 'vitest';
import {
  PRESS_WINDOW_MS,
  createFocusReturn,
  previousAsnFrom,
  shouldReturnFocus
} from '../src/main/focus-return';

const base = { isMac: true, pressAt: 1000, activatedAt: 1020, now: 1030, handled: false, focusWindowOpen: false };

describe('shouldReturnFocus', () => {
  it('hands back an activation that came with a press on the dog', () => {
    expect(shouldReturnFocus(base)).toBe(true);
  });
  it('also when the activation arrives just before the renderer reports the press', () => {
    expect(shouldReturnFocus({ ...base, activatedAt: 990 })).toBe(true);
  });
  it('never off macOS', () => {
    expect(shouldReturnFocus({ ...base, isMac: false })).toBe(false);
  });
  it('not while a Walder window that takes the keyboard is open', () => {
    expect(shouldReturnFocus({ ...base, focusWindowOpen: true })).toBe(false);
  });
  it('not without a press, nor without an activation', () => {
    expect(shouldReturnFocus({ ...base, pressAt: null })).toBe(false);
    expect(shouldReturnFocus({ ...base, activatedAt: null })).toBe(false);
  });
  it('not for an activation long before the press (opening the Walder window, say)', () => {
    expect(shouldReturnFocus({ ...base, activatedAt: 200 })).toBe(false);
  });
  it('not for a press long past', () => {
    expect(shouldReturnFocus({ ...base, now: 1000 + PRESS_WINDOW_MS + 1 })).toBe(false);
  });
  it('at most once per press', () => {
    expect(shouldReturnFocus({ ...base, handled: true })).toBe(false);
  });
});

describe('previousAsnFrom', () => {
  const list = 'ASN:0x0-0x119119-"TextEdit": ASN:0x0-0x34034-"Finder": ASN:0x0-0x5c05c-"Claude":';
  it('takes the front of the list when Walder is not in it (a UI element never is)', () => {
    expect(previousAsnFrom(list, 'ASN:0x0-0x999999')).toBe('ASN:0x0-0x119119');
    expect(previousAsnFrom(list, null)).toBe('ASN:0x0-0x119119');
  });
  it('takes the app right after Walder when Walder is listed', () => {
    const withMe = `ASN:0x0-0x777777-"Walder": ${list}`;
    expect(previousAsnFrom(withMe, 'ASN:0x0-0x777777')).toBe('ASN:0x0-0x119119');
  });
  it('gives null for an empty list, or Walder alone', () => {
    expect(previousAsnFrom('', null)).toBeNull();
    expect(previousAsnFrom('ASN:0x0-0x777777-"Walder":', 'ASN:0x0-0x777777')).toBeNull();
  });
});

describe('createFocusReturn', () => {
  function harness(opts: { focusWindowOpen?: boolean; listing?: string | null; isMac?: boolean } = {}) {
    let t = 0;
    const calls: string[] = [];
    const fr = createFocusReturn({
      isMac: opts.isMac ?? true,
      now: () => t,
      pid: 42,
      focusWindowOpen: () => opts.focusWindowOpen ?? false,
      exec: async (file, args) => {
        calls.push([file, ...args].join(' '));
        if (args[0] === 'visibleProcessList') return opts.listing === undefined ? 'ASN:0x0-0x119119-"TextEdit":' : opts.listing;
        if (args[0] === 'find') return 'ASN:0x0-0x777777:';
        if (args[0] === 'front') return 'ASN:0x0-0x119119:';
        return '';
      },
      log: () => {}
    });
    return { fr, calls, at: (ms: number) => { t = ms; } };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  const SETFRONT = '/usr/bin/lsappinfo setfront ASN:0x0-0x119119';
  const fronts = (calls: string[]) => calls.filter((c) => c.includes(' setfront '));

  it('press then activation: brings that exact process to the front once, never through open (a reopen event)', async () => {
    const h = harness();
    h.at(1000); h.fr.onPress();
    h.at(1020); h.fr.onActivated();
    h.at(1030); h.fr.onActivated();
    await flush();
    expect(fronts(h.calls)).toEqual([SETFRONT]);
    expect(h.calls.some((c) => c.startsWith('/usr/bin/open'))).toBe(false);
  });
  it('activation then press: the same', async () => {
    const h = harness();
    h.at(990); h.fr.onActivated();
    h.at(1000); h.fr.onPress();
    await flush();
    expect(h.calls).toContain(SETFRONT);
  });
  it('does nothing with the Walder window (or any focus window) open', async () => {
    const h = harness({ focusWindowOpen: true });
    h.at(1000); h.fr.onPress(); h.at(1020); h.fr.onActivated();
    await flush();
    expect(h.calls).toEqual([]);
  });
  it('does nothing for an activation with no press (tray, Walder window)', async () => {
    const h = harness();
    h.at(5000); h.fr.onActivated();
    await flush();
    expect(h.calls).toEqual([]);
  });
  it('guesses nothing when the app list cannot be read', async () => {
    const h = harness({ listing: null });
    h.at(1000); h.fr.onPress(); h.at(1020); h.fr.onActivated();
    await flush();
    expect(fronts(h.calls)).toEqual([]);
  });
  it('does nothing off macOS', async () => {
    const h = harness({ isMac: false });
    h.at(1000); h.fr.onPress(); h.at(1020); h.fr.onActivated();
    await flush();
    expect(h.calls).toEqual([]);
  });
  it('a second press gives focus back again', async () => {
    const h = harness();
    h.at(1000); h.fr.onPress(); h.at(1020); h.fr.onActivated();
    h.at(9000); h.fr.onPress(); h.at(9020); h.fr.onActivated();
    await flush();
    expect(fronts(h.calls)).toHaveLength(2);
  });
  it('a press while Walder is still active (an earlier hand-back failed) gives focus back', async () => {
    const h = harness();
    h.at(200); h.fr.onActivated();
    h.at(5000); h.fr.onPress();
    await flush();
    expect(fronts(h.calls)).toEqual([SETFRONT]);
  });
  it('after Walder resigned, a press with no activation does nothing', async () => {
    const h = harness();
    h.at(200); h.fr.onActivated();
    h.at(300); h.fr.onResigned();
    h.at(5000); h.fr.onPress();
    await flush();
    expect(h.calls).toEqual([]);
  });
});
