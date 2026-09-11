/**
 * What the login window is allowed to navigate to.
 *
 * **Rewritten 2026-09-08, after the owner could not log in.** The rule used to
 * be a host allowlist: claude.ai, chatgpt.com, their auth and asset hosts, and
 * the three consumer identity providers. That is now gone, and the reasoning
 * matters more than the code, because "we removed an allowlist" reads like a
 * step backwards.
 *
 * **Why an allowlist cannot work here.** Walder's owner is on a Claude Team plan
 * behind his company's single sign-on. "Continue with SSO" does not go to one of
 * three known hosts: it goes to whichever identity provider his employer bought
 * — Microsoft Entra, Okta, Google Workspace, OneLogin, Ping, JumpCloud, a
 * self-hosted Keycloak — and then through that vendor's CDN, its CAPTCHA
 * vendor, its MFA vendor, and sometimes a corporate proxy's own interstitial.
 * On his machine the page simply hung forever. Every one of those hops is a host
 * we cannot know in advance, and a list we tried to keep current would be wrong
 * for the next customer and stale by the next vendor migration. An allowlist
 * that blocks the login is not a security control; it is an outage.
 *
 * **What the allowlist was actually protecting.** The threat is a phishing page
 * loaded *inside* our window: something that looks like a login form, in a
 * window the owner opened from Walder's own tray, and so is inclined to trust.
 * That threat is real, and it is small — and it was all that was at stake, for
 * three reasons:
 *
 *  - **There is no bridge.** The window has no `preload`, `sandbox: true`,
 *    `contextIsolation: true` and `nodeIntegration: false`. A page here cannot
 *    reach Walder's IPC, the file system, or the settings store. It is a browser
 *    tab that happens to have our title bar.
 *  - **Cookies are not readable across origins.** The partition holds the
 *    claude.ai (or chatgpt.com) session cookie, and only claude.ai can read it.
 *    A page on any other host is not "browsing with the owner's session
 *    attached" — it is browsing with *its own* origin's cookies, which is what a
 *    browser does everywhere else too.
 *  - **The owner drives it.** Nothing navigates this window except the login
 *    flow he started and the links on the pages it shows him.
 *
 * So the policy is now the two things that are absolute rather than the many
 * that were guesswork:
 *
 *  1. **`https:` only.** Not `http:` (interceptable, and no real login uses
 *     it), not `file:` (the local disk), not `data:` or `javascript:` (script
 *     injection into a window holding a live session), not a custom app scheme
 *     (which hands a URL chosen by remote content to another application).
 *  2. **Never loopback.** `127.0.0.1`, `::1`, `localhost` and friends are *this
 *     machine* — including Walder's own hook listener on port 47811. Note what
 *     this does and does not buy: these handlers see *navigation*, so the rule
 *     keeps the window itself off this machine, but a page here can still
 *     `fetch` loopback exactly as a page in any browser tab can. What actually
 *     protects the listener is the listener — its `Host`, `Origin` and
 *     content-type checks in `hook-server.ts`. This rule is the outer layer.
 *
 * Everything else — which hosts an SSO flow walks through — is allowed, and
 * logged (host only, never the path or query) so the next report is actionable.
 *
 * Pure, no electron, so `login-window.ts` and its tests share one decision.
 */

/**
 * The hosts the two login flows *start* on.
 *
 * Not an allowlist, and not consulted on navigation: this is the pair of hosts
 * `LOGIN_URLS` in `login-window.ts` must point at, and that the `did-navigate`
 * backstop returns to. Pinned here (and by a test) so a typo in a start URL
 * cannot quietly send the owner somewhere else on the first load — the one
 * navigation Walder chooses rather than follows.
 */
export const LOGIN_START_HOSTS: readonly string[] = ['claude.ai', 'chatgpt.com'];

/** IPv4 dotted-quad, captured so the octets can be checked. */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * An IPv4-mapped IPv6 address, with the embedded address captured.
 *
 * Leading zero groups are optional so both the compressed `::ffff:…` and the
 * written-out `0:0:0:0:0:ffff:…` match.
 */
const V4_MAPPED_RE = /^(?:0+:)*:*ffff:([0-9a-f.:]+)$/;

/**
 * The IPv4 address an IPv4-mapped IPv6 address embeds, or `null`.
 *
 * Both tails have to be handled: a URL written `[::ffff:127.0.0.1]` keeps its
 * dotted tail, but `new URL()` normalizes the same address to the hex form
 * `[::ffff:7f00:1]` — and `hostname` is what this module is handed, so the hex
 * form is the one that actually shows up in production.
 */
function unmapIpv4(host: string): string | null {
  const mapped = V4_MAPPED_RE.exec(host);
  if (mapped === null) return null;
  const tail = mapped[1] ?? '';
  if (IPV4_RE.test(tail)) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (hex === null) return null;
  const high = Number.parseInt(hex[1] ?? '', 16);
  const low = Number.parseInt(hex[2] ?? '', 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * Is this hostname *this machine*?
 *
 * Broader than `=== '127.0.0.1'` on purpose, because every one of these reaches
 * the same listener: the whole `127.0.0.0/8` block (`127.0.0.2` is as local as
 * `127.0.0.1`), IPv6 `::1` in both the bare and the URL-bracketed form,
 * `0.0.0.0` (which routes to localhost on several stacks), the `localhost`
 * name plus the reserved `*.localhost` subdomains, the IPv4-mapped IPv6 form
 * (`::ffff:127.0.0.1`, which connects to the v4 listener on Darwin and Linux),
 * and any of the names written as a trailing-dot FQDN (`localhost.`), which
 * resolves identically but which the URL parser hands over with the dot still
 * on it.
 *
 * The numeric forms the URL parser *already* folds — `2130706433`, `0177.0.0.1`,
 * `127.1` — arrive here as `127.0.0.1` and need nothing special.
 */
export function isLoopbackHost(hostname: string): boolean {
  const bare = hostname
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
  // Judged by the address it embeds, so the mapped form cannot walk past the
  // rules below by being spelled in hex.
  const host = unmapIpv4(bare) ?? bare;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (host === '0.0.0.0') return true;
  const ipv4 = IPV4_RE.exec(host);
  if (ipv4 !== null) {
    const octets = ipv4.slice(1, 5).map(Number);
    if (octets.some((n) => n > 255)) return false;
    return octets[0] === 127;
  }
  return false;
}

/**
 * May the login window's **top-level page** (or a popup) navigate here?
 *
 * `https:`, and not this machine. See the file header for why that is the whole
 * rule — in short, an enterprise SSO flow walks through hosts nobody can
 * enumerate, and this window has no bridge into the app for a hostile page to
 * cross.
 */
export function isAllowedLoginUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return !isLoopbackHost(parsed.hostname);
}

/**
 * May a **subframe** of the login window navigate here?
 *
 * The same rule, plus an exemption for `about:blank`.
 *
 * Both login pages, and every identity provider behind them, are assembled out
 * of third-party frames: Cloudflare Turnstile, Google Identity Services,
 * reCAPTCHA, hCaptcha, Apple's `appleid.cdn-apple.com`, Microsoft's
 * `*.msauth.net`, Okta's and Duo's MFA widgets. Holding those to a host list is
 * what produced the four `blocked a subframe navigation` lines in the owner's
 * log on 2026-09-08 — the human check and the "continue with…" buttons never
 * rendered.
 *
 * `about:blank` is exempt and must be: an iframe (and a popup) starts there
 * before its real navigation, it carries no remote content, and preventing it
 * breaks every widget that builds its frame in script.
 */
export function isAllowedLoginSubframeUrl(url: string): boolean {
  if (url === '' || url === 'about:blank') return true;
  return isAllowedLoginUrl(url);
}

/**
 * Why a URL was refused, in the few words a log line needs.
 *
 * Separate from the boolean so a blocked-navigation line can say which of the
 * two rules bit, instead of leaving whoever reads the log to guess from the
 * host.
 */
export function loginDenyReason(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'unparseable URL';
  }
  if (parsed.protocol !== 'https:') return `scheme ${parsed.protocol} is not https`;
  if (isLoopbackHost(parsed.hostname)) return 'a loopback address (this machine)';
  return 'refused';
}

/**
 * The host of a URL, for a log line — never the path or the query.
 *
 * A navigation is only actionable in a bug report if the line says *which host*,
 * and a login URL's path and query carry one-time codes, `state` values, SAML
 * assertions and sometimes an email address. So the diagnostics get the host and
 * nothing else.
 */
export function loginUrlHost(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === '' ? '(no host)' : host;
  } catch {
    return '(unparseable url)';
  }
}
