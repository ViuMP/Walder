/**
 * The User-Agent the login partitions present.
 *
 * The owner reported on 2026-09-08 that "the login pages don't work". Part of
 * that was the navigation allowlist blocking the widget iframes; the other part
 * is here — Electron's default UA carries `Electron/44.2.0`, and Google refuses
 * OAuth sign-in from a UA that names an embedded browser, so the page would
 * render and the "continue with Google" button would then dead-end.
 *
 * The rule is a *subtraction*, and that is the property worth testing: nothing
 * is invented, no version is faked, no platform is changed — the two app tokens
 * are removed and what is left is the genuine Chrome UA of the Chromium this
 * build embeds.
 */
import { describe, expect, it } from 'vitest';
import { chromeUserAgent } from '../src/core/user-agent';

/** Electron 44's real default UA on this Mac, with Walder's product token. */
const ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Walder/0.1.1 Chrome/142.0.0.0 Electron/44.2.0 Safari/537.36';

describe('chromeUserAgent', () => {
  it('strips both the Electron and the Walder token', () => {
    const ua = chromeUserAgent(ELECTRON_UA);
    expect(ua).not.toMatch(/Electron/);
    expect(ua).not.toMatch(/Walder/);
  });

  it('leaves a UA Chrome itself would send', () => {
    expect(chromeUserAgent(ELECTRON_UA)).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
    );
  });

  it('keeps the Chrome and platform tokens exactly as they were', () => {
    // Not spoofing: the engine and the OS are the truth about what is rendering
    // the page, which is what the sites are actually asking.
    const ua = chromeUserAgent(ELECTRON_UA);
    expect(ua).toContain('Chrome/142.0.0.0');
    expect(ua).toContain('Macintosh; Intel Mac OS X 10_15_7');
    expect(ua).toContain('AppleWebKit/537.36');
    expect(ua).toContain('Safari/537.36');
  });

  it('leaves no double space where a token was removed', () => {
    expect(chromeUserAgent(ELECTRON_UA)).not.toMatch(/ {2}/);
  });

  it('works on the Windows and Linux forms too', () => {
    expect(
      chromeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Walder/0.1.1 Chrome/142.0.0.0 Electron/44.2.0 Safari/537.36'
      )
    ).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
    );
    expect(
      chromeUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Walder/0.1.1 Chrome/142.0.0.0 Electron/44.2.0 Safari/537.36'
      )
    ).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
    );
  });

  it('is idempotent, and a no-op on a UA that carries neither token', () => {
    const clean =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
    expect(chromeUserAgent(clean)).toBe(clean);
    expect(chromeUserAgent(chromeUserAgent(ELECTRON_UA))).toBe(chromeUserAgent(ELECTRON_UA));
    expect(chromeUserAgent('')).toBe('');
  });

  it('removes every occurrence, not just the first', () => {
    expect(chromeUserAgent('a Electron/1.2.3 b Electron/4.5 c Walder/0.1.1 d')).toBe('a b c d');
  });

  it('strips the token Electron actually emits, which is lowercase', () => {
    // Observed in the 2026-09-08 dev run, and missed by every test above:
    // Electron builds its product token from `package.json`'s `name`, so the
    // real UA says `walder/0.1.0`, not `Walder/0.1.0`. The case-sensitive rule
    // left it in every request to claude.ai, chatgpt.com and the owner's
    // employer's identity provider.
    const real =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) walder/0.1.0 Chrome/152.0.7977.76 Safari/537.36';
    expect(chromeUserAgent(real)).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.76 Safari/537.36'
    );
    expect(chromeUserAgent(real)).not.toMatch(/walder/i);
    expect(chromeUserAgent('x electron/44.2.0 y')).toBe('x y');
  });

  it('does not touch a lookalike that is not the token', () => {
    // Only ` Name/<digits and dots>` is a product token. A host or a word that
    // merely contains the name stays.
    expect(chromeUserAgent('Mozilla/5.0 ElectronJS/1.0 Chrome/142.0.0.0')).toBe(
      'Mozilla/5.0 ElectronJS/1.0 Chrome/142.0.0.0'
    );
    expect(chromeUserAgent('Mozilla/5.0 (Electron) Chrome/142.0.0.0')).toBe(
      'Mozilla/5.0 (Electron) Chrome/142.0.0.0'
    );
  });
});
