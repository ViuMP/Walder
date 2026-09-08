/**
 * "What happened the last time Walder checked this account?", in plain words.
 *
 * The owner reported on 2026-09-08 that he had logged in to ChatGPT inside
 * Walder's own window and the tray still said "login needed". He was right, and
 * the reason was a real bug (cookies were not being attached — see `http.ts`),
 * but the thing that made it a *mystery* rather than a bug report was that the
 * menu had nothing to say beyond "login needed". No time, no reason, no way to
 * tell "we asked and got a 401" from "we have not asked since Tuesday".
 *
 * So every authentication check a web provider makes leaves a one-line record —
 * held in memory in the provider, read synchronously when the tray menu is
 * built, and formatted here.
 *
 * **What may go in `detail`.** A fixed vocabulary of *shapes*: `HTTP 401`,
 * `timeout`, `not JSON`, `no access token`, `no organisation`. Never a response
 * body, never a header, never an account id and — deliberately, because it is
 * the obvious thing to reach for and the wrong thing to show — never the
 * owner's name or email address. "Logged in" is the whole of the good news; a
 * mascot's menu bar is not a place to publish who you are to anyone glancing at
 * the screen.
 *
 * Memory only. Nothing here is persisted: a check from a previous run is not
 * evidence about this one, and a settings file is not a place for a log.
 *
 * Pure, no electron and no clock of its own, so the wording is unit-testable.
 */

export interface AuthCheck {
  /** Was the owner logged in when this check ran? */
  readonly loggedIn: boolean;
  /**
   * The check itself could not complete — offline, timed out, aborted. Distinct
   * from `loggedIn: false`, which is an answer: "we asked, and you are not".
   */
  readonly failed: boolean;
  /**
   * A few words about *why*, for a menu line. A shape, never a value — see the
   * file header. Empty when there is nothing to add (a plain success).
   */
  readonly detail: string;
  /** Epoch milliseconds, from the caller's clock. */
  readonly at: number;
}

/** Build a record. Trivial, but it keeps the four fields in one place. */
export function authCheck(
  loggedIn: boolean,
  detail: string,
  at: number,
  failed = false
): AuthCheck {
  return { loggedIn, failed, detail, at };
}

/**
 * `12:03` in the machine's own time zone.
 *
 * Local, not UTC: the owner is comparing it against his own clock to answer
 * "was that before or after I logged in?", which is the only question this
 * timestamp exists to answer. Seconds are dropped — a poll is every three
 * minutes and the extra precision would only be noise.
 */
export function clockTime(at: number): string {
  const when = new Date(at);
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** What the tray shows when nothing has been checked yet this run. */
export const NOT_CHECKED_LINE = 'Login not checked yet';

/**
 * The Accounts submenu's second line for one service.
 *
 * Four states, and each one tells the owner something different about what to
 * do next: nothing yet (wait, or hit Refresh), logged in (nothing to do),
 * answered but not logged in (log in — and the reason says whether the session
 * expired or something odder is happening), and could not ask at all (a network
 * problem, not a login problem — do not go hunting for a password).
 */
export function lastCheckLine(check: AuthCheck | null): string {
  if (check === null) return NOT_CHECKED_LINE;
  const at = clockTime(check.at);
  if (check.failed) {
    return check.detail === ''
      ? `Check failed (${at})`
      : `Check failed: ${check.detail} (${at})`;
  }
  if (check.loggedIn) return `Logged in (checked ${at})`;
  return check.detail === ''
    ? `Not logged in (checked ${at})`
    : `Not logged in — last check: ${check.detail} (${at})`;
}
