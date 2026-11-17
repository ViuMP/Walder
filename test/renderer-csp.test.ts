/**
 * The renderer's production Content-Security-Policy, pinned (audit B2,
 * 2026-11-17). The policy is injected at build time by the `walderCsp` plugin
 * in `electron.vite.config.ts`, so nothing else in the suite sees it; calling
 * the plugin's hook directly checks the policy a production build ships.
 */
import { describe, expect, it } from 'vitest';
import { walderCsp } from '../electron.vite.config';

type Handler = (html: string, ctx: { path: string; server?: unknown }) => string;

function handler(): Handler {
  const hook = walderCsp().transformIndexHtml as unknown as { handler: Handler };
  return hook.handler;
}

describe('walderCsp', () => {
  it('locks the production page out of the network', () => {
    const html = handler()('<head><!--WALDER_CSP--></head>', { path: '/panel.html' });
    const policy = /content="([^"]+)"/.exec(html)?.[1] ?? '';
    for (const directive of [
      "connect-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
      "script-src 'self'"
    ]) {
      expect(policy.split('; ')).toContain(directive);
    }
    expect(html).not.toContain('WALDER_CSP');
  });

  it('opens connect-src to the dev server only under `electron-vite dev`', () => {
    const html = handler()('<!--WALDER_CSP-->', { path: '/panel.html', server: {} });
    expect(html).toContain('connect-src ws://localhost:* http://localhost:*');
    expect(html).not.toContain("connect-src 'none'");
  });

  it('fails the build for a page without the marker', () => {
    expect(() => handler()('<head></head>', { path: '/new.html' })).toThrow(
      /missing <!--WALDER_CSP-->/
    );
  });
});
