/**
 * `npm run probe:fullscreen` — print, once a second, the geometry the fullscreen
 * watch decides from (macOS only, read-only, Ctrl-C to stop).
 *
 * Written for the open fault "Chrome window-fullscreen with its toolbar showing
 * is not detected" (`docs/handoffs/RECHECK_2026-11-18.md` §b): the only record
 * of that state is "content window 996 px high", which is not enough to change
 * `coversDisplayAllowingMenuBar` without guessing. This prints what is needed
 * instead: the frontmost app, **every** window `openWindows()` lists for it
 * (the watch hands all of them to `isFullscreenWindows`), every display, and
 * each window's verdict against each display.
 *
 * It loads `get-windows` the way `main/fullscreen-watch.ts` does (`lib/macos.js`
 * by file URL, without the screen-recording or accessibility prompts) and
 * prints only owner name, pid, bounds and the current rule's verdict. **Never a
 * title, URL or memory figure**: `get-windows` returns a browser's page title
 * and URL, and they are dropped here before anything is printed.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { coversDisplayAllowingMenuBar, coversDisplay } from '../src/core/fullscreen';
import type { Rect } from '../src/core/geometry';

interface RawWindow {
  bounds?: Rect;
  owner?: { name?: string; processId?: number };
}
type Query = (options?: unknown) => Promise<unknown>;

const OPTIONS = { screenRecordingPermission: false, accessibilityPermission: false };

/** One AppKit screen frame, in points, bottom-left origin. */
export interface AppKitFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * AppKit frames to the top-left coordinates `get-windows` reports. The primary
 * (menu-bar) screen is `NSScreen.screens[0]`, not `mainScreen` (that is the one
 * holding the key window); it alone sits at (0, 0), and every flip is against its height.
 */
export function toTopLeft(frames: readonly AppKitFrame[]): Rect[] {
  const primaryHeight = frames[0]?.height ?? 0;
  return frames.map((f) => ({ x: f.x, y: primaryHeight - (f.y + f.height), width: f.width, height: f.height }));
}

/** Every display's frame, primary first, in AppKit points. */
function screenFrames(): AppKitFrame[] {
  const json = execFileSync(
    'osascript',
    [
      '-l',
      'JavaScript',
      '-e',
      'ObjC.import("AppKit"); const a = $.NSScreen.screens; const out = [];' +
        'for (let i = 0; i < a.count; i++) { const f = a.objectAtIndex(i).frame;' +
        ' out.push({ x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height }); }' +
        'JSON.stringify(out)'
    ],
    { encoding: 'utf8' }
  );
  return JSON.parse(json) as AppKitFrame[];
}

function fmt(r: Rect): string {
  return `${r.width}x${r.height} at (${r.x}, ${r.y})`;
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.log('macOS only.');
    return;
  }
  const url = pathToFileURL(join(process.cwd(), 'node_modules', 'get-windows', 'lib', 'macos.js')).href;
  const mod = (await import(url)) as { activeWindow: Query; openWindows: Query };
  const displays = toTopLeft(screenFrames());
  displays.forEach((d, i) => console.log(`display ${i}${i === 0 ? ' (primary)' : ''}: ${fmt(d)}`));

  for (;;) {
    const [active, all] = (await Promise.all([mod.activeWindow(OPTIONS), mod.openWindows(OPTIONS)])) as [
      RawWindow | undefined,
      RawWindow[] | undefined
    ];
    const pid = active?.owner?.processId;
    const name = active?.owner?.name ?? '(none)';
    console.log(`${new Date().toISOString()}  front: ${name} pid ${pid ?? '?'}`);
    for (const win of all ?? []) {
      const b = win.bounds;
      if (win.owner?.processId !== pid || b === undefined) continue;
      // Like the watch with no dog display: every display is a candidate.
      const verdicts = displays
        .map((d, i) => `\n    display ${i}: strict=${coversDisplay(b, d)} menuBarRule=${coversDisplayAllowingMenuBar(b, d)}`)
        .join('');
      console.log(`  window ${fmt(b)}${verdicts}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Only when run as a script; the test imports `toTopLeft`.
if (process.argv[1] !== undefined && process.argv[1].endsWith('fullscreen-probe.ts')) void main();
