/**
 * The User-Agent the login partitions present.
 *
 * Electron's default UA is Chrome's with two extra tokens bolted on:
 *
 *   Mozilla/5.0 (Macintosh; …) AppleWebKit/537.36 (KHTML, like Gecko)
 *   Walder/0.1.1 Chrome/142.0.0.0 Electron/44.2.0 Safari/537.36
 *
 * Both are a problem for a login window (2026-09-08):
 *
 *  - `Electron/44.2.0` marks the request as an *embedded browser*, and Google
 *    refuses OAuth sign-in from those outright ("this browser or app may not be
 *    secure"). Microsoft and Apple apply similar checks, and the anti-bot
 *    layers in front of both login pages score an unknown UA as suspicious.
 *  - `Walder/0.1.1` names an application nobody's allowlist has heard of, and
 *    versions our app to every site the owner logs in to for no benefit.
 *
 * Stripping the two tokens leaves the genuine Chrome UA of the Chromium this
 * build actually embeds — so it is honest about the engine rendering the page,
 * which is what the sites are asking about. It is *not* spoofing a different
 * browser: no version is invented and no platform is changed.
 *
 * Applied to the whole partition session, so it covers the login window's own
 * requests, its subframes, and later the provider `session.fetch` polls that run
 * on the same partition — those hit the same anti-bot layers.
 *
 * Pure, no electron, so it can be tested directly.
 */

/**
 * The tokens to remove: ` Electron/<version>` and ` Walder/<version>`.
 *
 * The leading space is part of the match so that removing a token in the middle
 * of the string does not leave a double space behind.
 *
 * **Case-insensitive, and that is load-bearing** — found in the 2026-09-08 dev
 * run rather than by a test, which is why the test below now pins it. Electron
 * builds its product token from the `package.json` `name`, which is `walder`,
 * so the real UA on this machine reads `… walder/0.1.0 Chrome/152.0.7977.76 …`
 * in lowercase. The case-sensitive version stripped `Electron/44.2.0` and left
 * `walder/0.1.0` in every request to claude.ai, chatgpt.com and the owner's
 * employer's identity provider: a product token nobody's allowlist has heard of,
 * announcing the app and its version to every site he logs in to.
 *
 * A name that merely *contains* the word is still safe, because the `/` and the
 * version number are part of the match: `ElectronJS/1.0` and `(Electron)` stay.
 */
const APP_TOKEN_RE = / (Electron|Walder)\/[\d.]+/gi;

/**
 * Strip Electron's and Walder's tokens from a User-Agent string.
 *
 * Returns the input unchanged when neither token is present, so a UA that has
 * already been cleaned (or one from a plain Chromium) passes through untouched.
 */
export function chromeUserAgent(userAgent: string): string {
  return userAgent.replace(APP_TOKEN_RE, '');
}
