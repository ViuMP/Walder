/**
 * The login window's navigation allowlist.
 *
 * The login window is the one place Walder shows real web content, and it holds
 * a live session partition whose cookies the poller later uses. If it could be
 * navigated anywhere, that navigation would be browsing with the owner's Claude
 * or ChatGPT session attached — so the interesting tests here are the *denials*,
 * and in particular the near-misses that a sloppy suffix check would wave
 * through.
 */
import { describe, expect, it } from 'vitest';
import { LOGIN_HOST_ALLOWLIST, isAllowedLoginUrl } from '../src/core/login-hosts';

describe('isAllowedLoginUrl', () => {
  it('allows the two products and their auth hosts', () => {
    for (const url of [
      'https://claude.ai/login',
      'https://claude.ai/api/organizations',
      'https://console.anthropic.com/oauth/authorize',
      'https://chatgpt.com/auth/login',
      'https://auth.openai.com/authorize',
      'https://auth0.openai.com/u/login'
    ]) {
      expect(isAllowedLoginUrl(url)).toBe(true);
    }
  });

  it('allows the identity providers a real login offers', () => {
    // "Continue with Google/Microsoft/Apple" are part of the flow; denying them
    // would leave some owners unable to log in at all.
    for (const url of [
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      'https://login.microsoftonline.com/common/oauth2/authorize',
      'https://appleid.apple.com/auth/authorize'
    ]) {
      expect(isAllowedLoginUrl(url)).toBe(true);
    }
  });

  it('denies a host that merely ends with an allowed name', () => {
    // The classic suffix bug: `endsWith('openai.com')` says yes to all of these.
    for (const url of [
      'https://evilopenai.com/',
      'https://notclaude.ai/',
      'https://myanthropic.com/',
      'https://xchatgpt.com/'
    ]) {
      expect(isAllowedLoginUrl(url)).toBe(false);
    }
  });

  it('denies an allowed name used as a prefix of another domain', () => {
    for (const url of [
      'https://claude.ai.attacker.example/login',
      'https://chatgpt.com.phish.example/',
      'https://accounts.google.com.evil.example/'
    ]) {
      expect(isAllowedLoginUrl(url)).toBe(false);
    }
  });

  it('denies Auth0 tenants other than OpenAI\'s own', () => {
    // `.auth0.com` used to be on the list, which is every Auth0 customer's
    // tenant — an open door held for a host OpenAI does not even use. OpenAI's
    // own tenant is `auth0.openai.com`, covered by `.openai.com`.
    expect(isAllowedLoginUrl('https://auth0.openai.com/u/login')).toBe(true);
    for (const url of [
      'https://openai.us.auth0.com/authorize',
      'https://evil.auth0.com/authorize',
      'https://auth0.com/'
    ]) {
      expect(isAllowedLoginUrl(url)).toBe(false);
    }
  });

  it('denies unrelated hosts, however plausible', () => {
    for (const url of [
      'https://github.com/login',
      'https://google.com/',
      'https://accounts.google.evil/',
      'https://cdn.jsdelivr.net/x.js'
    ]) {
      expect(isAllowedLoginUrl(url)).toBe(false);
    }
  });

  it('requires https', () => {
    // A login flow that drops to plain HTTP is either broken or intercepted;
    // neither is something to follow with a live session cookie.
    expect(isAllowedLoginUrl('http://claude.ai/login')).toBe(false);
    expect(isAllowedLoginUrl('https://claude.ai/login')).toBe(true);
  });

  it('denies every non-http scheme, including the dangerous ones', () => {
    for (const url of [
      'javascript:alert(document.cookie)',
      'file:///etc/passwd',
      'data:text/html,<script>1</script>',
      'about:blank',
      'ftp://claude.ai/',
      'chatgpt://open'
    ]) {
      expect(isAllowedLoginUrl(url)).toBe(false);
    }
  });

  it('denies a malformed URL rather than throwing', () => {
    expect(isAllowedLoginUrl('')).toBe(false);
    expect(isAllowedLoginUrl('not a url')).toBe(false);
    expect(isAllowedLoginUrl('///')).toBe(false);
  });

  it('is case-insensitive about the host', () => {
    expect(isAllowedLoginUrl('https://CLAUDE.AI/login')).toBe(true);
    expect(isAllowedLoginUrl('https://Auth.OpenAI.com/authorize')).toBe(true);
  });

  it('honours a caller-supplied allowlist, and an empty one denies everything', () => {
    expect(isAllowedLoginUrl('https://example.com/', ['example.com'])).toBe(true);
    expect(isAllowedLoginUrl('https://claude.ai/login', [])).toBe(false);
  });

  it('does not accept a bare wildcard suffix as a whole host', () => {
    // `.openai.com` must match a *subdomain*, not the empty label.
    expect(isAllowedLoginUrl('https://.openai.com/')).toBe(false);
  });

  it('lists no third-party identity estate, only named hosts', () => {
    expect(LOGIN_HOST_ALLOWLIST).not.toContain('.auth0.com');
    expect(LOGIN_HOST_ALLOWLIST).not.toContain('auth0.com');
  });

  it('lists only the hosts a real login walks through', () => {
    // A guard against the list quietly growing: every entry should be one of
    // the two products, their auth services, or a named identity provider.
    for (const entry of LOGIN_HOST_ALLOWLIST) {
      expect(entry).toMatch(
        /(claude\.ai|anthropic\.com|chatgpt\.com|openai\.com|accounts\.google\.com|login\.microsoftonline\.com|appleid\.apple\.com)$/
      );
    }
  });
});
