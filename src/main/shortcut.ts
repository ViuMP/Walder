/**
 * The global shortcut for hiding and un-hiding Walder.
 *
 * Thin on purpose: which combinations exist, what they are called and whether a
 * stored one is usable are all in `core/shortcuts.ts`, pure and unit-tested.
 * What is here is the part that talks to Electron, and it exists as its own file
 * because registration is the one operation in this app that *routinely fails
 * for reasons outside the app*, and every one of those failures has to be
 * survivable:
 *
 *  - **Another app already owns the keys.** `globalShortcut.register` returns
 *    `false`. The setting is **kept** regardless — quitting whatever took them
 *    makes it work again next launch, and silently rewriting the owner's choice
 *    to something else would be worse than a shortcut that does nothing. The
 *    menu says so instead (`shortcutStatusLine`).
 *  - **A malformed accelerator throws**, rather than returning false. A
 *    hand-edited settings file can produce one, so the call is wrapped —
 *    `core/shortcuts.ts` also rejects it up front, and this is the belt to that
 *    braces.
 *  - **Either way, startup continues.** A mascot that refused to start because a
 *    keyboard shortcut was taken would be absurd. `apply` returns a status and
 *    never throws.
 *
 * `register`/`unregister` are injectable so the whole thing can be driven
 * without an Electron app; the defaults are `globalShortcut`'s own.
 *
 * Verified on this Mac (2026-09-09): all eight presets in `SHORTCUT_PRESETS`
 * register successfully; `Control+Super+W` is refused *even on macOS*, which is
 * the second reason `Super` appears in no preset. macOS registers these through
 * Carbon, so no accessibility permission is involved and no dialog appears.
 */
import { globalShortcut } from 'electron';
import { looksLikeAccelerator, type ShortcutStatus } from '../core/shortcuts';
import { vlog, warn } from './log';

export interface ShortcutBinderDeps {
  /** The keys were pressed. */
  readonly onToggle: () => void;
  /** Defaults to `globalShortcut.register`. */
  readonly register?: (accelerator: string, callback: () => void) => boolean;
  /** Defaults to `globalShortcut.unregister`. */
  readonly unregister?: (accelerator: string) => void;
}

export interface ShortcutBinder {
  /**
   * Bind `accelerator`, releasing whatever was bound before. Returns what
   * happened; never throws.
   */
  apply(accelerator: string): ShortcutStatus;
  /** What the last `apply` produced. `unregistered` before the first one. */
  status(): ShortcutStatus;
  /** The accelerator currently held, or `null` when nothing is bound. */
  current(): string | null;
  /** Release the keys. Wired to `will-quit`. */
  dispose(): void;
}

export function createShortcutBinder(deps: ShortcutBinderDeps): ShortcutBinder {
  const register =
    deps.register ??
    ((accelerator: string, callback: () => void): boolean =>
      globalShortcut.register(accelerator, callback));
  const unregister =
    deps.unregister ?? ((accelerator: string): void => globalShortcut.unregister(accelerator));

  let bound: string | null = null;
  let status: ShortcutStatus = 'unregistered';

  /**
   * Let go of the keys we hold, if any.
   *
   * Unconditionally before every `apply`, and this ordering is not optional:
   * re-registering while the old accelerator is still held leaks a hotkey the
   * OS will keep delivering to a callback nobody meant to leave armed — and
   * re-applying the *same* accelerator would then hit its own registration and
   * report "already in use".
   */
  function release(): void {
    if (bound === null) return;
    try {
      unregister(bound);
    } catch (error) {
      // Nothing can be done about it and nothing depends on it succeeding.
      warn('could not release the hide shortcut:', error);
    }
    bound = null;
  }

  return {
    apply(accelerator: string): ShortcutStatus {
      release();

      if (!looksLikeAccelerator(accelerator)) {
        warn(`the hide shortcut "${accelerator}" is not usable; it is switched off`);
        status = 'invalid';
        return status;
      }

      let taken = false;
      try {
        taken = register(accelerator, deps.onToggle);
      } catch (error) {
        warn(`could not register the hide shortcut ${accelerator}:`, error);
        status = 'invalid';
        return status;
      }

      if (!taken) {
        // One line, not one per attempt: this is a condition the owner cannot
        // fix from inside Walder, and the menu carries the message.
        warn(`${accelerator} is already in use, so the hide shortcut is off`);
        status = 'in-use';
        return status;
      }

      bound = accelerator;
      status = 'registered';
      vlog('hide shortcut registered:', accelerator);
      return status;
    },

    status(): ShortcutStatus {
      return status;
    },

    current(): string | null {
      return bound;
    },

    dispose(): void {
      release();
      status = 'unregistered';
    }
  };
}
