/**
 * The global-shortcut binder.
 *
 * Registration is the one operation in Walder that routinely fails for reasons
 * outside the app — another app owns the keys, or the settings file has been
 * hand-edited — and each failure has a specific way of being handled wrong:
 *
 *  - a refusal that **discarded the owner's setting** would leave him choosing
 *    the same combination again every time the other app happened to be running;
 *  - a malformed accelerator **throws** rather than returning false, and an
 *    unguarded call would take the whole launch with it;
 *  - re-applying without releasing first would **leak a hotkey** the OS keeps
 *    delivering, and would make re-applying the same combination report
 *    "already in use" against its own registration.
 *
 * `register`/`unregister` are injected, so no Electron app is involved; the
 * `electron` module is still mocked because the file imports `globalShortcut`
 * for its defaults.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  registered: [] as string[],
  unregistered: [] as string[],
  warns: [] as unknown[][]
}));

vi.mock('electron', () => ({
  globalShortcut: {
    register: (accelerator: string) => {
      host.registered.push(accelerator);
      return true;
    },
    unregister: (accelerator: string) => {
      host.unregistered.push(accelerator);
    }
  }
}));

const { createShortcutBinder } = await import('../src/main/shortcut');

beforeEach(() => {
  host.registered.length = 0;
  host.unregistered.length = 0;
  host.warns.length = 0;
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    host.warns.push(args);
  });
});

/** A binder over a register that answers `answers.shift()` each time. */
function binderWith(answers: (boolean | 'throw')[]): {
  binder: ReturnType<typeof createShortcutBinder>;
  registered: string[];
  unregistered: string[];
  toggles: number;
} {
  const registered: string[] = [];
  const unregistered: string[] = [];
  const counter = { n: 0 };
  const binder = createShortcutBinder({
    onToggle: () => {
      counter.n++;
    },
    register: (accelerator: string) => {
      registered.push(accelerator);
      const answer = answers.shift() ?? true;
      if (answer === 'throw') throw new Error('conversion failure from Super');
      return answer;
    },
    unregister: (accelerator: string) => {
      unregistered.push(accelerator);
    }
  });
  return {
    binder,
    registered,
    unregistered,
    get toggles(): number {
      return counter.n;
    }
  };
}

describe('createShortcutBinder', () => {
  it('registers the accelerator and reports it', () => {
    const { binder, registered } = binderWith([true]);
    expect(binder.status()).toBe('unregistered');
    expect(binder.current()).toBeNull();

    expect(binder.apply('Control+Command+W')).toBe('registered');
    expect(registered).toEqual(['Control+Command+W']);
    expect(binder.status()).toBe('registered');
    expect(binder.current()).toBe('Control+Command+W');
  });

  it('calls back when the keys are pressed', () => {
    const calls: string[] = [];
    const binder = createShortcutBinder({
      onToggle: () => calls.push('toggle'),
      register: (_accelerator: string, callback: () => void) => {
        callback();
        return true;
      },
      unregister: () => {}
    });
    binder.apply('Shift+F9');
    expect(calls).toEqual(['toggle']);
  });

  it('keeps the setting when another app already owns the keys', () => {
    // The whole point: quitting that app makes the shortcut work again, and the
    // menu explains the situation in the meantime.
    const { binder } = binderWith([false]);
    expect(binder.apply('Control+Command+W')).toBe('in-use');
    expect(binder.status()).toBe('in-use');
    // Nothing is held, so `dispose` has nothing to release.
    expect(binder.current()).toBeNull();
    expect(host.warns).toHaveLength(1);
  });

  it('never throws on a malformed accelerator, and does not reach Electron', () => {
    const { binder, registered } = binderWith([]);
    expect(() => binder.apply('Control+')).not.toThrow();
    expect(binder.apply('Super+W')).toBe('invalid');
    // Rejected by `looksLikeAccelerator` before `register` is called at all —
    // which is what stops a hand-edited settings file throwing during launch.
    expect(registered).toEqual([]);
  });

  it('survives a register that throws', () => {
    const { binder } = binderWith(['throw']);
    expect(binder.apply('Control+Shift+F12')).toBe('invalid');
    expect(binder.current()).toBeNull();
    expect(host.warns).toHaveLength(1);
  });

  it('releases the previous accelerator before registering the next', () => {
    const { binder, registered, unregistered } = binderWith([true, true]);
    binder.apply('Control+Command+W');
    binder.apply('Shift+F9');
    expect(unregistered).toEqual(['Control+Command+W']);
    expect(registered).toEqual(['Control+Command+W', 'Shift+F9']);
    expect(binder.current()).toBe('Shift+F9');
  });

  it('re-applying the same accelerator does not report it as in use', () => {
    // It would, if the old registration were still held when the new one was
    // attempted.
    const { binder, unregistered } = binderWith([true, true]);
    binder.apply('Shift+F9');
    expect(binder.apply('Shift+F9')).toBe('registered');
    expect(unregistered).toEqual(['Shift+F9']);
  });

  it('releases the keys on dispose, and forgets what it held', () => {
    const { binder, unregistered } = binderWith([true]);
    binder.apply('Shift+F9');
    binder.dispose();
    expect(unregistered).toEqual(['Shift+F9']);
    expect(binder.status()).toBe('unregistered');
    expect(binder.current()).toBeNull();
    // Idempotent: `will-quit` can fire after an explicit teardown.
    binder.dispose();
    expect(unregistered).toEqual(['Shift+F9']);
  });

  it('survives an unregister that throws', () => {
    const binder = createShortcutBinder({
      onToggle: () => {},
      register: () => true,
      unregister: () => {
        throw new Error('nothing to unregister');
      }
    });
    binder.apply('Shift+F9');
    expect(() => binder.dispose()).not.toThrow();
    expect(binder.current()).toBeNull();
  });

  it('falls back to globalShortcut when nothing is injected', () => {
    const binder = createShortcutBinder({ onToggle: () => {} });
    expect(binder.apply('Control+Command+W')).toBe('registered');
    expect(host.registered).toEqual(['Control+Command+W']);
    binder.dispose();
    expect(host.unregistered).toEqual(['Control+Command+W']);
  });
});
