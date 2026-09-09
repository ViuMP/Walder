/**
 * The menu-bar bone.
 *
 * The icon is generated from a text grid (`scripts/tray-bone.ts`), which makes it
 * reviewable in a diff — and not checkable by eye at the size it ships at. 16x16
 * gives about eleven usable pixels once the outline inset is accounted for, and
 * at that size the difference between a bone and a dumbbell, or between a bone
 * and a blob, is one pixel per lobe. So the properties that make the silhouette
 * *read* as a bone are pinned here: it is symmetric both ways, its shaft is much
 * thinner than its lobes, and no ink touches the border (where the Windows
 * variant's one-pixel outline would be clipped off the icon).
 *
 * None of this asserts the artwork cell by cell. A redraw should be free; a
 * redraw that stops looking like a bone should not be.
 */
import { describe, expect, it } from 'vitest';
import {
  BONE_GRID,
  BONE_LOBE_COLUMNS,
  BONE_SHAFT_COLUMNS,
  BONE_SIZE
} from '../scripts/tray-bone';

function cell(x: number, y: number): string {
  return (BONE_GRID[y] as string)[x] as string;
}

function inkedInColumn(x: number): number {
  let count = 0;
  for (let y = 0; y < BONE_SIZE; y++) if (cell(x, y) === '#') count++;
  return count;
}

describe('the tray bone grid', () => {
  it('is a square grid of the declared size', () => {
    // The generator indexes it as `BONE[gy][gx]` with no bounds check beyond the
    // size constant, so a short row would render as transparent pixels.
    expect(BONE_SIZE).toBe(16);
    expect(BONE_GRID).toHaveLength(BONE_SIZE);
    for (const [y, row] of BONE_GRID.entries()) {
      expect(row.length, `row ${y}`).toBe(BONE_SIZE);
    }
  });

  it('uses only ink and empty cells', () => {
    for (const [y, row] of BONE_GRID.entries()) {
      expect([...row].every((ch) => ch === '#' || ch === '.'), `row ${y}: ${row}`).toBe(true);
    }
  });

  it('has ink', () => {
    const total = BONE_GRID.join('').split('').filter((ch) => ch === '#').length;
    expect(total).toBeGreaterThan(40);
  });

  it('is symmetric left to right', () => {
    // A bone with one fat end reads as a club, and at 16 px nobody would be able
    // to say what was wrong with it.
    for (const [y, row] of BONE_GRID.entries()) {
      expect(row, `row ${y}`).toBe([...row].reverse().join(''));
    }
  });

  it('is symmetric top to bottom', () => {
    for (let y = 0; y < BONE_SIZE; y++) {
      expect(BONE_GRID[y], `row ${y}`).toBe(BONE_GRID[BONE_SIZE - 1 - y]);
    }
  });

  it('keeps every inked cell off the border', () => {
    // The Windows/Linux variant draws a one-pixel dark outline in the cells
    // *around* the ink. Ink on row 0 or column 15 leaves that outline nowhere to
    // go, and the icon ships with a clipped edge on a dark taskbar.
    for (let i = 0; i < BONE_SIZE; i++) {
      expect(cell(i, 0), `top, column ${i}`).toBe('.');
      expect(cell(i, BONE_SIZE - 1), `bottom, column ${i}`).toBe('.');
      expect(cell(0, i), `left, row ${i}`).toBe('.');
      expect(cell(BONE_SIZE - 1, i), `right, row ${i}`).toBe('.');
    }
  });

  it('has a shaft strictly thinner than its lobes', () => {
    // This is the whole shape. Measured down a column: the middle of the bone is
    // just the shaft, the ends are a pair of lobes joined by it. A "slightly
    // bolder" edit that thickens the shaft turns it into a bar.
    const shaft = BONE_SHAFT_COLUMNS.map(inkedInColumn);
    const lobe = BONE_LOBE_COLUMNS.map(inkedInColumn);

    for (const [i, count] of shaft.entries()) {
      expect(count, `shaft column ${BONE_SHAFT_COLUMNS[i]}`).toBeGreaterThan(0);
    }
    expect(Math.max(...shaft) * 2).toBeLessThanOrEqual(Math.min(...lobe));
  });

  it('leaves a notch between the two lobes at each end', () => {
    // What distinguishes a bone from a dumbbell: the shaft does not reach the
    // outermost column, so the two lobes at each end are visibly separate.
    const columnAt = (x: number): string => BONE_GRID.map((row) => row[x]).join('');
    for (const x of [1, BONE_SIZE - 2]) {
      // Two runs of ink separated by a gap, read top to bottom.
      const runs = columnAt(x)
        .split(/\.+/)
        .filter((run) => run.length > 0);
      expect(runs.length, `column ${x}: ${columnAt(x)}`).toBe(2);
    }
  });
});
