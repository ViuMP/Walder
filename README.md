# Walder

A pixel-art desktop mascot — a golden long-haired mini dachshund — who sits on
your desktop and shows how much of your AI subscriptions you have left.

He changes expression as your Claude 5-hour window fills up, barks with a little
speech bubble when you cross 80 / 85 / 90 / 95 / 100 %, curls up and sleeps tiny
while you watch something fullscreen, and perks up when Claude Code finishes a
reply.

macOS and Windows, built with Electron.

## Status

Stage **M2a** — project scaffold and the pure logic core. There is no artwork,
no tray icon and no network access yet: `npm run dev` opens a plain window that
says "Walder". The sprite work and the usage providers land in later stages.

## Getting started

You need [Node.js](https://nodejs.org/) 22.12 or newer (24 recommended).

```bash
npm install     # also downloads the Electron runtime (~130 MB, first time only)
npm run dev
```

## npm scripts

| Script                | What it does                                                        |
| --------------------- | ------------------------------------------------------------------- |
| `npm run dev`         | Run the app in development, with hot reload.                        |
| `npm run build`       | Compile main, preload and renderer into `out/`.                     |
| `npm run sprites`     | Run the app straight onto the sprite gallery page (stub for now).   |
| `npm test`            | Run the unit tests once.                                            |
| `npm run test:watch`  | Run the unit tests and re-run them as files change.                 |
| `npm run typecheck`   | Type-check everything without emitting files.                       |
| `npm run dist:mac`    | Build a distributable macOS app into `release/`.                    |
| `npm run dist:win`    | Build a distributable Windows installer into `release/`.             |
| `npm run dist:all`    | Build both.                                                          |
| `npm run install-hooks` | Install the repo's git hooks (stub — prints TODO).                 |

## Layout

```
src/core/       Pure TypeScript: no Electron, no network, fully unit-tested.
                buckets.ts      parse provider usage payloads into Bucket[]
                expression.ts   usage % -> which face to show
                nudge.ts        when to bark, what to queue, when to sleep
                hittest.ts      per-pixel click-through for the overlay window
src/main/       Electron main process (windows, tray, timers).
src/preload/    The contextBridge seam between main and renderer.
src/renderer/   The overlay window, the usage panel, the sprite gallery.
test/           Vitest suites and captured provider fixtures.
```

Anything under `src/core/` must stay free of Electron imports so it can be
tested in plain Node — that is what keeps the tricky logic (threshold firing,
window resets, tolerant payload parsing) provable.
