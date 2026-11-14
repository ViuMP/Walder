/**
 * Audit F2 (the owner's yes, 2026-11-14): the hover card's text against the
 * card it is drawn on.
 *
 * The card is cream at alpha 0.82 in a transparent window (`panel.html`,
 * departure 2; `transparent: true` and nothing behind it in `hover-panel.ts`),
 * so what the text really sits on is that cream over whatever is on screen. The
 * design's `--muted`, `--pct` and the bar red reused for stale text were 3.49,
 * 2.32 and 2.58 to 1 with black behind the card, where WCAG AA asks 4.5 of
 * text this small.
 *
 * The renderer cannot run here (vitest under node, no jsdom), so nothing is
 * measured off a screen: the colours are read out of the stylesheet and the
 * WCAG arithmetic is done on them. Every `color: var(--…)` in the sheet is
 * checked, not a typed list of three, so a text colour added later is held to
 * the same bar without anybody remembering this file.
 */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const html = readFileSync(new URL('../src/renderer/panel.html', import.meta.url), 'utf8');

type Rgb = readonly number[];

/** A custom property's value as the stylesheet declares it. */
function prop(name: string): string {
  const value = new RegExp(`^\\s*${name}: ([^;]+);`, 'm').exec(html)?.[1];
  if (value === undefined) throw new Error(`panel.html declares no ${name}`);
  return value;
}

const hex = (value: string): Rgb => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));

/** WCAG 2 relative luminance of an sRGB colour, channels 0 to 255. */
function luminance(rgb: Rgb): number {
  const [r = 0, g = 0, b = 0] = rgb.map((channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, 1 to 21. */
function contrast(a: Rgb, b: Rgb): number {
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The card's background as it reaches the eye over a grey `desktop` (0 to 255). */
function cardOver(desktop: number): Rgb {
  const [r = 0, g = 0, b = 0, alpha = 1] = (prop('--card').match(/[\d.]+/g) ?? []).map(Number);
  return [r, g, b].map((channel) => alpha * channel + (1 - alpha) * desktop);
}

/** Every custom property the sheet uses as a text colour. */
const textColours = [
  ...new Set(Array.from(html.matchAll(/(?<![-\w])color: var\((--[\w-]+)\)/g), (m) => m[1] ?? ''))
];

it('finds the card’s text colours, the stale red among them and not the bar’s', () => {
  expect(textColours).toEqual(expect.arrayContaining(['--ink', '--muted', '--pct', '--stale']));
  // `--red` is a bar colour from the design file. It is not held to a text
  // ratio, and so it must not be text.
  expect(textColours).not.toContain('--red');
});

it.each(textColours)('%s is 4.5:1 or better on the card, whatever is behind it', (name) => {
  const colour = hex(prop(name));
  const overBlack = contrast(colour, cardOver(0));
  // Black is the binding case: dark text on a light card loses contrast as the
  // card darkens, and the card is darkest over black.
  expect(overBlack).toBeLessThan(contrast(colour, cardOver(255)));
  expect(overBlack).toBeGreaterThanOrEqual(4.5);
});
