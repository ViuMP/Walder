/**
 * `npm run probe:fullscreen` — print, once a second, the geometry the fullscreen
 * watch decides from (macOS only, read-only, Ctrl-C to stop).
 *
 * Written for the open fault "Chrome window-fullscreen with its toolbar showing
 * is not detected" (`docs/handoffs/RECHECK_2026-11-18.md` §b): the only record
 * of that state is "content window 996 px high", which is not enough to change
 * `coversDisplayAllowingMenuBar` without guessing. This prints what is needed
 * instead: the frontmost app, **every** window `openWindows()` lists for it
 * (the watch hands all of them to `isFullscreenWindows`), and the main display.
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

/** The main display's frame and visible frame, in points (AppKit's bottom-left origin). */
function mainScreen(): string {
  return execFileSync(
    'osascript',
    [
      '-l',
      'JavaScript',
      '-e',
      'ObjC.import("AppKit"); const s = $.NSScreen.mainScreen; const f = s.frame, v = s.visibleFrame;' +
        '`frame ${f.size.width}x${f.size.height}  visibleFrame ${v.size.width}x${v.size.height} at (${v.origin.x}, ${v.origin.y})`'
    ],
    { encoding: 'utf8' }
  ).trim();
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
  const screenLine = mainScreen();
  const size = /frame (\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/.exec(screenLine);
  // The main display sits at (0, 0) in the top-left coordinates get-windows reports.
  const display: Rect | null =
    size === null ? null : { x: 0, y: 0, width: Number(size[1]), height: Number(size[2]) };
  console.log(`main display: ${screenLine}`);

  for (;;) {
    const [active, all] = (await Promise.all([mod.activeWindow(OPTIONS), mod.openWindows(OPTIONS)])) as [
      RawWindow | undefined,
      RawWindow[] | undefined
    ];
    const pid = active?.owner?.processId;
    const name = active?.owner?.name ?? '(none)';
    console.log(`${new Date().toISOString()}  front: ${name} pid ${pid ?? '?'}`);
    for (const win of all ?? []) {
      if (win.owner?.processId !== pid || win.bounds === undefined) continue;
      const verdict =
        display === null
          ? ''
          : `  strict=${coversDisplay(win.bounds, display)} menuBarRule=${coversDisplayAllowingMenuBar(win.bounds, display)}`;
      console.log(`  window ${fmt(win.bounds)}${verdict}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

void main();
