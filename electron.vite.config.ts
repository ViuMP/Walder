import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * Inject the renderer's Content-Security-Policy at build time.
 *
 * A static `<meta>` cannot serve both modes: production wants
 * `connect-src 'none'` (the renderer talks only to main, over IPC, and must not
 * be able to reach the network), while `electron-vite dev` needs the Vite HMR
 * websocket, which `'none'` blocks — the M2a review logged exactly that.
 *
 * The alternative, `session.webRequest.onHeadersReceived`, was rejected:
 * Electron's webRequest does not reliably intercept `file://` responses, which is
 * precisely the production case that matters most. Injecting here keeps one
 * source of truth for the policy and adds no dependency.
 *
 * Every renderer page carries a `<!--WALDER_CSP-->` marker; a page missing it
 * fails the build rather than shipping unprotected.
 */
function walderCsp(): Plugin {
  const MARKER = '<!--WALDER_CSP-->';

  return {
    name: 'walder-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const isDev = ctx.server !== undefined;
        const connect = isDev
          ? 'connect-src ws://localhost:* http://localhost:*'
          : "connect-src 'none'";
        const policy = [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          connect,
          "object-src 'none'",
          "frame-src 'none'",
          "base-uri 'none'"
        ].join('; ');

        if (!html.includes(MARKER)) {
          throw new Error(
            `${ctx.path}: missing ${MARKER}. Every renderer page must carry the CSP marker.`
          );
        }
        return html.replace(
          MARKER,
          `<meta http-equiv="Content-Security-Policy" content="${policy}" />`
        );
      }
    }
  };
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: r('src/main/index.ts') }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: r('src/preload/index.ts') },
        // Electron cannot load an ESM preload in a sandboxed renderer, so emit CJS
        // with a .cjs extension even though the package itself is "type": "module".
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    plugins: [walderCsp()],
    build: {
      rollupOptions: {
        input: {
          overlay: r('src/renderer/overlay.html'),
          panel: r('src/renderer/panel.html'),
          'sprites-dev': r('src/renderer/sprites-dev.html')
        }
      }
    }
  }
});
