/**
 * The menu-bar bone, as a 16x16 text grid.
 *
 * Its own module rather than a `const` inside `gen-tray-icon.ts` for one reason:
 * a shape drawn as ASCII is reviewable in a diff but not *checkable* by eye at
 * the size it ships at. 16x16 is 11 px of usable ink after the outline inset, and
 * at that size the difference between a bone and a dumbbell is one pixel per
 * lobe. `test/tray-bone.test.ts` pins the properties that make it read as a bone
 * — left/right and top/bottom symmetry, a shaft strictly thinner than the lobes,
 * ink kept off the border so the Windows variant's one-pixel outline is not
 * clipped — so a future tweak that breaks one of them fails `npm test` instead of
 * shipping and being noticed a version later.
 *
 * `#` is ink, `.` is empty. The icon generator handles colour, the outline and
 * the 1x/2x rasterisation; this file is only the shape.
 */

/** Grid side, in cells. Both tray variants are square. */
export const BONE_SIZE = 16;

/**
 * Rows 4-11, columns 1-14.
 *
 * The anatomy, top to bottom: two lobes side by side at each end (rows 4-6 and
 * 9-11), a 2-px shaft joining them across the middle (rows 7-8), and the notch
 * between each pair of lobes at columns 1 and 14, where the shaft does not reach.
 * The outermost column of each lobe is dropped on its first and last row, which
 * is what rounds the lobe instead of leaving it a 4x3 block.
 *
 * The four blank rows top and bottom, and the inset from columns 0 and 15, are
 * deliberate: the menu bar gives the icon 22 logical pixels of height and crops
 * to the ink, so a bone that filled the grid would come out larger than every
 * other icon in the bar — and ink on the border would leave the Windows outline
 * (drawn one cell *outside* the ink) with nowhere to go.
 */
export const BONE_GRID: readonly string[] = [
  '................',
  '................',
  '................',
  '................',
  '..##........##..',
  '.####......####.',
  '.####......####.',
  '..############..',
  '..############..',
  '.####......####.',
  '.####......####.',
  '..##........##..',
  '................',
  '................',
  '................',
  '................'
];

/**
 * Columns through the middle of the bone, where only the shaft is.
 *
 * "Thinner" is measured down a column, not along a row: these columns carry two
 * inked cells (the shaft's two rows) against the eight of a lobe column below.
 * That ratio is what makes the silhouette a bone rather than a bar — and it is
 * the first thing a well-meant "make it a bit bolder" edit destroys.
 */
export const BONE_SHAFT_COLUMNS: readonly number[] = [6, 7, 8, 9];

/** Columns through a pair of lobes, one at each end. */
export const BONE_LOBE_COLUMNS: readonly number[] = [2, 3, 12, 13];
