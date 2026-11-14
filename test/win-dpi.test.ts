/**
 * Audit finding M3: the Windows fullscreen helper's rects in Electron's units.
 *
 * The helper used to run DPI-unaware, so Windows handed it 96-DPI *logical*
 * rects in which each monitor keeps its physical top-left. Electron's displays
 * are DIPs laid out edge to edge. The two agree on a single display at any
 * scale and disagree on mixed-scale layouts, where a film on a display that
 * Windows and Chromium place differently never covered the dog's display. The
 * helper now reports physical pixels (`"physical":1`) and `main/win-dpi.ts`
 * maps them into DIPs through the display Windows put the window on.
 *
 * Each layout below is a real display arrangement written in both spaces the
 * way Chromium computes them (physical origin kept, DIP origin packed edge to
 * edge), and each case runs the *real* decision (`core/fullscreen.ts`) on the
 * mapped sample, so what is asserted is the dog's behaviour, not the
 * arithmetic alone. Pure: no Electron, no PowerShell, so it holds on every CI
 * platform.
 *
 * The geometry is taken from Windows' own numbers: a maximised window's rect
 * overhangs its monitor by an 8-physical-pixel resize border on the left, top
 * and right, and stops 8 px below the top of the taskbar (48 px tall at 100 %,
 * 60 at 125 %, 72 at 150 %).
 */
import { describe, expect, it, vi } from 'vitest';
import { isFullscreenWindow } from '../src/core/fullscreen';
import {
  physicalDisplayFor,
  physicalToDip,
  sampleToDip,
  type DisplayUnits
} from '../src/main/win-dpi';

vi.mock('electron-store', () => ({ default: class {} }));
vi.mock('electron', () => ({
  app: { getName: () => 'Walder', isPackaged: false, getAppPath: () => '/app' },
  screen: { getAllDisplays: () => [] }
}));

const { parseWinLine, winSampleToDip } = await import('../src/main/fullscreen-watch');

type Rect = { x: number; y: number; width: number; height: number };

const SELF = { names: ['Walder'], processId: 1 };

/** The resize border Windows includes in a maximised window's rect, physical px. */
const RESIZE_BORDER = 8;
/** Taskbar height in physical px at 100 %; it scales with the display. */
const TASKBAR_AT_100 = 48;

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

/** A display of 1920 × 1200 physical pixels at `scale`, at a physical and a DIP origin. */
function display(scale: number, physX: number, dipX: number): DisplayUnits {
  return {
    physical: rect(physX, 0, 1920, 1200),
    dip: rect(dipX, 0, 1920 / scale, 1200 / scale)
  };
}

/** A sample of a fullscreen film on `d`: exactly its physical rect. */
function film(d: DisplayUnits): { bounds: Rect; monitor: Rect; ownerName: string } {
  return { bounds: d.physical, monitor: d.physical, ownerName: 'chrome' };
}

/** A sample of a maximised, not fullscreen, window on `d` with a taskbar at `scale`. */
function maximised(d: DisplayUnits, scale: number): { bounds: Rect; monitor: Rect; ownerName: string } {
  const p = d.physical;
  const workBottom = p.y + p.height - TASKBAR_AT_100 * scale;
  return {
    bounds: rect(
      p.x - RESIZE_BORDER,
      p.y - RESIZE_BORDER,
      p.width + 2 * RESIZE_BORDER,
      workBottom + RESIZE_BORDER - (p.y - RESIZE_BORDER)
    ),
    monitor: p,
    ownerName: 'chrome'
  };
}

/** Does this physical sample, mapped, put a dog sitting on `dog` to sleep? */
function sleeps(
  sample: { bounds: Rect; monitor: Rect; ownerName: string },
  displays: readonly DisplayUnits[],
  dog: DisplayUnits
): boolean {
  const mapped = sampleToDip(sample, displays);
  return isFullscreenWindow(
    mapped,
    displays.map((d) => d.dip),
    SELF,
    dog.dip
  );
}

describe('physical helper samples, mapped to DIPs (audit M3)', () => {
  it('single display at 100 %: a film sleeps him, a maximised window does not', () => {
    const only = display(1, 0, 0);
    const displays = [only];
    expect(sampleToDip(film(only), displays)?.bounds).toEqual(rect(0, 0, 1920, 1200));
    expect(sleeps(film(only), displays, only)).toBe(true);
    expect(sleeps(maximised(only, 1), displays, only)).toBe(false);
  });

  it('single display at 125 %: the film lands on the 1536 × 960 DIP display exactly', () => {
    const only = display(1.25, 0, 0);
    const displays = [only];
    expect(sampleToDip(film(only), displays)?.bounds).toEqual(rect(0, 0, 1536, 960));
    expect(sleeps(film(only), displays, only)).toBe(true);
    // (-8,-8)-(1928,1148) physical is about (-6,-6)-(1542,918) in DIPs: wider
    // than the display, but 42 DIPs short of its bottom, so not fullscreen.
    expect(sampleToDip(maximised(only, 1.25), displays)?.bounds).toEqual(rect(-6, -6, 1548, 924));
    expect(sleeps(maximised(only, 1.25), displays, only)).toBe(false);
  });

  describe('primary at 150 % with a 100 % display to its right', () => {
    // Windows keeps the secondary at physical x = 1920; Chromium packs its DIP
    // origin against the primary's 1280-DIP width.
    const primary = display(1.5, 0, 0);
    const secondary = display(1, 1920, 1280);
    const displays = [primary, secondary];

    it('a film on the secondary puts a dog on the secondary to sleep', () => {
      expect(sampleToDip(film(secondary), displays)?.bounds).toEqual(secondary.dip);
      expect(sleeps(film(secondary), displays, secondary)).toBe(true);
    });

    it('but not a dog on the primary, and a film there sleeps only a dog there', () => {
      expect(sleeps(film(secondary), displays, primary)).toBe(false);
      expect(sleeps(film(primary), displays, primary)).toBe(true);
      expect(sleeps(film(primary), displays, secondary)).toBe(false);
    });

    it('a maximised window on either display does not', () => {
      expect(sleeps(maximised(secondary, 1), displays, secondary)).toBe(false);
      expect(sleeps(maximised(primary, 1.5), displays, primary)).toBe(false);
    });

    it('is the layout the old logical rects missed', () => {
      // What the unaware helper reported for the same film: physical origin,
      // 96-DPI size. Passed through unmapped (no `physical` flag), it sits 640
      // units right of Electron's display, and the dog stayed awake.
      const logical = { bounds: rect(1920, 0, 1920, 1200), ownerName: 'chrome' };
      expect(winSampleToDip(logical, () => displays)).toEqual(logical);
      expect(isFullscreenWindow(logical, displays.map((d) => d.dip), SELF, secondary.dip)).toBe(false);
    });
  });

  describe('a 150 % display to the left of a 100 % primary', () => {
    // Physical origin −1920; Chromium's DIP origin −1280.
    const left = display(1.5, -1920, -1280);
    const primary = display(1, 0, 0);
    const displays = [primary, left];

    it('a film on the left display puts a dog there to sleep', () => {
      expect(sampleToDip(film(left), displays)?.bounds).toEqual(left.dip);
      expect(sleeps(film(left), displays, left)).toBe(true);
    });

    it('but not a dog on the primary; a maximised window on either does not', () => {
      expect(sleeps(film(left), displays, primary)).toBe(false);
      expect(sleeps(maximised(left, 1.5), displays, left)).toBe(false);
      expect(sleeps(maximised(primary, 1), displays, primary)).toBe(false);
    });
  });

  it('chooses the scale by the monitor Windows reported, not by the window’s overhang', () => {
    const primary = display(1.5, 0, 0);
    const secondary = display(1, 1920, 1280);
    // A maximised window on the primary overhangs 8 px into the secondary.
    const sample = maximised(primary, 1.5);
    expect(physicalDisplayFor(sample.monitor, [primary, secondary])).toBe(primary);
    expect(physicalToDip(sample.bounds, primary).x).toBe(-5);
  });

  it('keeps the monitor in the same units as the window', () => {
    const only = display(1.25, 0, 0);
    expect(sampleToDip(film(only), [only])?.monitor).toEqual(only.dip);
  });

  it('with no displays at all, leaves both rects physical (still self-consistent)', () => {
    const sample = film(display(1.25, 0, 0));
    expect(sampleToDip(sample, [])).toEqual(sample);
    // The decision's last resort then compares the window with its own monitor.
    expect(isFullscreenWindow(sampleToDip(sample, []), [], SELF, null)).toBe(true);
  });

  it('reads a sample on no known display as no window, never as a physical-vs-DIP guess', () => {
    const only = display(1.25, 0, 0);
    const elsewhere = { bounds: rect(5000, 0, 1920, 1200), monitor: rect(5000, 0, 1920, 1200), ownerName: 'x' };
    expect(sampleToDip(elsewhere, [only])).toBeNull();
  });

  it('skips a display with no physical extent rather than dividing by zero', () => {
    const only = display(1, 0, 0);
    const broken: DisplayUnits = { dip: rect(0, 0, 1920, 1200), physical: rect(0, 0, 0, 0) };
    expect(sampleToDip(film(only), [broken, only])?.bounds).toEqual(rect(0, 0, 1920, 1200));
  });
});

describe('winSampleToDip: which helper lines are mapped', () => {
  const only = display(1.25, 0, 0);

  it('maps a line the helper marked physical, and drops the flag', () => {
    const line =
      '{"pid":7,"name":"chrome","rect":{"l":0,"t":0,"r":1920,"b":1200},' +
      '"monitor":{"l":0,"t":0,"r":1920,"b":1200},"physical":1}';
    const parsed = parseWinLine(line);
    expect(parsed?.physical).toBe(true);
    expect(winSampleToDip(parsed, () => [only])).toEqual({
      bounds: rect(0, 0, 1536, 960),
      ownerName: 'chrome',
      ownerProcessId: 7,
      monitor: rect(0, 0, 1536, 960)
    });
  });

  it('leaves an unaware (logical) line alone: scaling it again would break 125 %', () => {
    // What a helper writes when per-monitor awareness is unavailable, and what
    // every helper wrote before M3: already 1536 × 960 on this display.
    for (const flag of ['', ',"physical":0']) {
      const line =
        '{"pid":7,"name":"chrome","rect":{"l":0,"t":0,"r":1536,"b":960},' +
        `"monitor":{"l":0,"t":0,"r":1536,"b":960}${flag}}`;
      const parsed = parseWinLine(line);
      expect(parsed?.physical).toBeUndefined();
      const displays = vi.fn(() => [only]);
      expect(winSampleToDip(parsed, displays)?.bounds).toEqual(rect(0, 0, 1536, 960));
      // And the live display list is not even read for it.
      expect(displays).not.toHaveBeenCalled();
    }
  });

  it('passes "no window" through', () => {
    expect(winSampleToDip(null, () => [only])).toBeNull();
  });
});
