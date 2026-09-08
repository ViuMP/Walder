import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

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
