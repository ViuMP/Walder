/**
 * The login window's navigation allowlist.
 *
 * A login window is the one place Walder shows real web content, and it holds a
 * live session partition whose cookies the poller later uses. If that window
 * could be navigated anywhere, a malicious link in a login flow — or an OAuth
 * `redirect_uri` that has been tampered with — would be browsing with the
 * owner's ChatGPT or Claude session attached. So navigation is allowlisted, not
 * blocklisted: anything not named here is denied.
 *
 * The list is exactly the hosts a real login walks through: the two products,
 * their auth services, and the third-party identity providers those offer
 * ("continue with Google/Microsoft/Apple"). Nothing else, and nothing wildcarded
 * more loosely than a single suffix.
 *
 * Pure, no electron, so `login-window.ts` and its tests share one decision.
 */

/**
 * Allowed hosts. A leading `.` means "this domain and any subdomain of it";
 * anything else must match the host exactly.
 */
export const LOGIN_HOST_ALLOWLIST: readonly string[] = [
  'claude.ai',
  '.claude.ai',
  '.anthropic.com',
  'anthropic.com',
  'chatgpt.com',
  '.chatgpt.com',
  'openai.com',
  '.openai.com',
  'auth.openai.com',
  // No `.auth0.com`: that is Auth0's whole multi-tenant estate, i.e. every
  // customer of theirs, and OpenAI's own Auth0 tenant is served from
  // `auth0.openai.com` — already covered by `.openai.com` above.
  'accounts.google.com',
  'login.microsoftonline.com',
  'appleid.apple.com'
];

function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const lower = host.toLowerCase();
  for (const entry of allowlist) {
    if (entry.startsWith('.')) {
      // `.openai.com` matches `auth.openai.com` but NOT `evilopenai.com`, and
      // not `openai.com.attacker.net` either — the suffix must be preceded by a
      // dot boundary that is part of the match.
      if (lower.endsWith(entry) && lower.length > entry.length) return true;
      continue;
    }
    if (lower === entry) return true;
  }
  return false;
}

/**
 * May the login window navigate to this URL?
 *
 * `https:` only — a login flow that drops to plain HTTP is either broken or
 * being intercepted, and neither is something to follow with a live session
 * cookie. Everything non-HTTP (`file:`, `data:`, custom app schemes, the
 * `javascript:` a tampered page might try) is refused outright.
 */
export function isAllowedLoginUrl(
  url: string,
  allowlist: readonly string[] = LOGIN_HOST_ALLOWLIST
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return hostAllowed(parsed.hostname, allowlist);
}
