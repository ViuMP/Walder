/**
 * Should Walder ask Claude Code to renew its own login right now?
 *
 * **What renewal is.** Claude Code's OAuth access token lasts about eight
 * hours. When it lapses overnight, Walder has nothing to read and the Claude
 * card sits on `auth-needed` until the owner happens to open Claude Code again
 * — which, on a day he works in something else, is all day. The fix is not to
 * refresh the token: spending the `refreshToken` *rotates* the pair, and the
 * CLI would find its own stored credential stale and log the owner out of the
 * very tool this mascot watches (`providers/credentials.ts`, rule 2, verified
 * 2026-09-08). The fix is to let the CLI do what it already does on every
 * launch — start `claude` with an empty prompt and let it renew its own
 * credential, in its own process, with its own refresh token. Walder never sees
 * or spends anything. This module decides *whether*; `main/claude-renew.ts`
 * does the spawning.
 *
 * Three gates, and each of them exists because of a way this could misbehave on
 * a machine nobody is watching.
 *
 * **One attempt per distinct expiry.** `attemptedFor` remembers the expiry we
 * last acted on. If the attempt did not move the credential — no CLI, a CLI
 * that cannot reach the network, a login that has been revoked outright — the
 * expiry is unchanged, so the next poll asks about the same number and is
 * refused. A failure therefore stops, once, instead of spawning a process every
 * three minutes until somebody notices. A *successful* renewal writes a new
 * expiry, which is a different number, which re-arms the whole thing for free.
 *
 * **A cooldown on top.** The permanent block is keyed on one number, and there
 * are ways to get two different numbers in quick succession: two profiles'
 * credentials, a poll and a manual **Refresh now** landing either side of a
 * write, a renewal that half-succeeded. Ten minutes between attempts bounds the
 * worst case to one child process per ten minutes whatever else goes wrong.
 *
 * **The margin, and why it is under five.** Claude Code renews on launch when
 * its own token is inside *its* five-minute margin. Outside that margin the
 * launch is a no-op: the CLI exits with the credential untouched, we read an
 * unmoved expiry, call it a failure, and `attemptedFor` then blocks the attempt
 * that would actually have worked. Four minutes keeps every attempt inside the
 * window where the CLI will act.
 *
 * Pure: no clock, no Electron, no node. The caller passes `now`.
 */

/**
 * How close to expiry the token must be before a renewal is worth attempting.
 *
 * Must stay under Claude Code's own 5-minute refresh margin: inside its margin
 * the CLI renews on launch; outside it the launch is a no-op that we would then
 * read as a failure and never retry.
 */
export const RENEW_MARGIN_MS = 4 * 60_000;

/** The floor between two attempts, whatever their expiries. */
export const RENEW_COOLDOWN_MS = 10 * 60_000;

/** What the last attempt was for, and when. Both `null` before the first one. */
export interface RenewState {
  readonly attemptedFor: number | null;
  readonly lastAttemptAt: number | null;
}

/**
 * `renew` is the only verdict that acts. The other four are named rather than
 * folded into one `false` so the caller can log *why* nothing happened — a
 * renewal that never fires is otherwise indistinguishable from one that is
 * broken.
 */
export type RenewVerdict = 'renew' | 'no-login' | 'already-attempted' | 'cooldown' | 'fresh';

/**
 * The whole decision, in the order the gates have to be asked.
 *
 * `already-attempted` is checked before `cooldown` deliberately: the permanent
 * block is the stronger answer, and reporting the temporary one for an expiry
 * that will never be retried anyway would be a lie that reads as "try again in
 * ten minutes".
 *
 * An expiry already in the past is `renew`, not a lost cause: the CLI renews an
 * expired credential from its refresh token perfectly well, and the overnight
 * lapse this exists for is precisely that case.
 */
export function shouldRenew(
  expiresAt: number | null,
  state: RenewState,
  now: number
): RenewVerdict {
  if (expiresAt === null) return 'no-login';
  if (state.attemptedFor === expiresAt) return 'already-attempted';
  if (state.lastAttemptAt !== null && now - state.lastAttemptAt < RENEW_COOLDOWN_MS) {
    return 'cooldown';
  }
  if (expiresAt - now >= RENEW_MARGIN_MS) return 'fresh';
  return 'renew';
}
