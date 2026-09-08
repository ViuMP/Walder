/**
 * What the login window may navigate to.
 *
 * The policy changed on 2026-09-08 and these tests changed with it, so the
 * *shape* of the suite is the first thing to read. There used to be a host
 * allowlist, and the interesting cases were near-misses a sloppy suffix check
 * would wave through (`evilopenai.com`, `claude.ai.attacker.example`). Those
 * cases are gone because the allowlist is gone: the owner signs in to a Claude
 * Team account through his employer's SSO, which walks through identity, CDN,
 * CAPTCHA and MFA hosts nobody can enumerate, and the list left him on a page
 * that loaded forever.
 *
 * So `https://evil.example/` is now *allowed* at the top level, and that is a
 * deliberate, documented trade (see `login-hosts.ts` for what the list was and
 * was not protecting — no preload, no IPC bridge, and cookies readable only by
 * their own origin). What is still refused is what is absolute: anything that is
 * not `https:`, and anything pointing back at this machine, where Walder's own
 * hook listener lives.
 */
import { describe, expect, it } from 'vitest';
import {
  LOGIN_START_HOSTS,
  isAllowedLoginSubframeUrl,
  isAllowedLoginUrl,
  isLoopbackHost,
  loginDenyReason,
  loginUrlHost
} from '../src/core/login-hosts';

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

  it('allows the consumer identity providers a login offers', () => {
    for (const url of [
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      'https://login.microsoftonline.com/common/oauth2/authorize',
      'https://appleid.apple.com/auth/authorize',
      'https://login.live.com/oauth20_authorize.srf',
      'https://challenges.cloudflare.com/turnstile/v0/manage'
    ]) {
      expect(isAllowedLoginUrl(url)).toBe(true);
    }
  });

  it('allows the enterprise SSO hosts an allowlist could never have named', () => {
    // The reported bug, as assertions. "Continue with SSO" on a Team plan goes
    // to whichever identity provider the employer bought, then that vendor's
    // CDN, CAPTCHA and MFA hosts, and sometimes a corporate interstitial. Not
    // one of these was on the old list, and the page hung forever.
    for (const url of [
      'https://login.microsoftonline.com/9188040d-abcd/saml2',
      'https://acme.okta.com/app/anthropic/exk123/sso/saml',
      'https://acme.onelogin.com/trust/saml2/http-post/sso',
      'https://sso.jumpcloud.com/saml2/anthropic',
      'https://auth.pingone.eu/abc/saml20/idp/sso',
      'https://keycloak.acme.internal.example/realms/corp/protocol/saml',
      'https://api-abcdef.duosecurity.com/frame/v4/auth/prompt'
    ]) {
      expect(isAllowedLoginUrl(url)).toBe(true);
    }
  });

  it('allows an unknown https host at the top level, deliberately', () => {
    // Not an oversight. The window has no preload, no IPC bridge and no
    // cross-origin cookie access; an allowlist that blocks the login is an
    // outage, not a control. See the file header of `login-hosts.ts`.
    expect(isAllowedLoginUrl('https://evil.example/')).toBe(true);
    expect(isAllowedLoginUrl('https://claude.ai.attacker.example/login')).toBe(true);
  });

  it('requires https, whatever the host', () => {
    // A login flow that drops to plain HTTP is either broken or intercepted;
    // neither is something to follow with a live session cookie.
    expect(isAllowedLoginUrl('http://claude.ai/login')).toBe(false);
    expect(isAllowedLoginUrl('https://claude.ai/login')).toBe(true);
  });

  it('denies every non-https scheme, including the dangerous ones', () => {
    for (const url of [
      'javascript:alert(document.cookie)',
      'file:///etc/passwd',
      'data:text/html,<script>1</script>',
      'about:blank',
      'ftp://claude.ai/',
      'chatgpt://open',
      'ws://claude.ai/socket'
    ]) {
      expect(isAllowedLoginUrl(url)).toBe(false);
    }
  });

  it('never lets the login window address this machine', () => {
    // Walder's own hook listener is on http://127.0.0.1:8787, and the scheme
    // rule already covers that form; these are the https ones, which it does
    // not. A page in this window must not be able to talk to the app that
    // opened it, however carefully that listener validates what it receives.
    for (const url of [
      'https://127.0.0.1:8787/event',
      'https://127.0.0.2/',
      'https://localhost:3000/',
      'https://app.localhost/',
      'https://[::1]:8787/event',
      'https://0.0.0.0/'
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
    expect(isAllowedLoginUrl('https://LocalHost/')).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it('recognises the whole 127.0.0.0/8 block, not just 127.0.0.1', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', '127.1.2.3', '127.255.255.254']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it('recognises the names and the IPv6 forms', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'anything.localhost',
      '::1',
      '[::1]',
      '0:0:0:0:0:0:0:1',
      '0.0.0.0'
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it('leaves ordinary hosts alone, including lookalikes', () => {
    for (const host of [
      'claude.ai',
      'localhost.evil.example',
      'notlocalhost',
      '128.0.0.1',
      '12.7.0.1',
      '999.0.0.1',
      '127.0.0.1.evil.example'
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe('isAllowedLoginSubframeUrl', () => {
  it('allows any https frame, because a login page is built out of them', () => {
    // The four `blocked a subframe navigation` lines in the owner's log, as
    // assertions: these are the widget hosts the claude.ai, chatgpt.com and
    // enterprise IdP pages embed.
    for (const url of [
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile',
      'https://accounts.google.com/gsi/iframe/select',
      'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js',
      'https://www.recaptcha.net/recaptcha/api2/bframe',
      'https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html',
      'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.frame.html',
      'https://api-abcdef.duosecurity.com/frame/v4/auth/prompt',
      'https://some-vendor.example/widget'
    ]) {
      expect(isAllowedLoginSubframeUrl(url)).toBe(true);
    }
  });

  it('holds a subframe to the same two rules as the page', () => {
    for (const url of [
      'http://challenges.cloudflare.com/turnstile',
      'http://claude.ai/login',
      'file:///etc/passwd',
      'data:text/html,<script>1</script>',
      'javascript:alert(document.cookie)',
      'ftp://claude.ai/',
      'https://127.0.0.1:8787/event',
      'https://localhost/',
      'not a url',
      '///'
    ]) {
      expect(isAllowedLoginSubframeUrl(url)).toBe(false);
    }
  });

  it('exempts about:blank, which an iframe starts on', () => {
    // No remote content, and preventing it breaks widgets that build their
    // frame in script before pointing it anywhere. The page-level rule does not
    // exempt it: a committed top-level `about:blank` is handled separately in
    // `login-window.ts`.
    expect(isAllowedLoginSubframeUrl('about:blank')).toBe(true);
    expect(isAllowedLoginSubframeUrl('')).toBe(true);
    expect(isAllowedLoginUrl('about:blank')).toBe(false);
  });
});

describe('LOGIN_START_HOSTS', () => {
  it('names the two products and no third-party estate', () => {
    // Not an allowlist: this is only the pair of hosts the start URLs point at,
    // pinned so a typo cannot send the owner elsewhere on the first load. The
    // start URLs themselves are checked against it in `login-window.test.ts`.
    expect(LOGIN_START_HOSTS).toHaveLength(2);
    for (const host of LOGIN_START_HOSTS) {
      expect(host).toMatch(/^(claude\.ai|chatgpt\.com)$/);
    }
  });
});

describe('loginDenyReason', () => {
  it('says which of the two rules bit', () => {
    expect(loginDenyReason('http://claude.ai/')).toBe('scheme http: is not https');
    expect(loginDenyReason('file:///etc/passwd')).toBe('scheme file: is not https');
    expect(loginDenyReason('https://127.0.0.1:8787/event')).toBe(
      'a loopback address (this machine)'
    );
    expect(loginDenyReason('not a url')).toBe('unparseable URL');
  });

  it('never quotes the URL back', () => {
    // These strings go into the log beside a host, and a login URL's path and
    // query carry one-time codes and sometimes an email address.
    const reason = loginDenyReason('https://localhost/callback?code=SECRET&email=a@b.c');
    expect(reason).not.toContain('SECRET');
    expect(reason).not.toContain('a@b.c');
  });
});

describe('loginUrlHost', () => {
  it('returns the host and nothing else', () => {
    // A navigation is only actionable in a bug report if the log names the
    // host — and the path and query carry one-time codes and SAML assertions.
    expect(loginUrlHost('https://acme.okta.com/x/y?token=secret&email=a@b.c')).toBe(
      'acme.okta.com'
    );
    expect(loginUrlHost('https://CLAUDE.AI/login')).toBe('claude.ai');
    expect(loginUrlHost('https://accounts.google.com:443/o/oauth2/v2/auth')).toBe(
      'accounts.google.com'
    );
  });

  it('never throws, whatever it is handed', () => {
    expect(loginUrlHost('not a url')).toBe('(unparseable url)');
    expect(loginUrlHost('')).toBe('(unparseable url)');
    expect(loginUrlHost('javascript:alert(1)')).toBe('(no host)');
    expect(loginUrlHost('about:blank')).toBe('(no host)');
  });
});
