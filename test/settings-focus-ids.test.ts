/**
 * Keyboard focus survives a save (Windows on-screen pass, 2026-11-18).
 *
 * Every save re-renders the settings pages, and `renderSettings` puts focus
 * back by `document.activeElement.id`. A control built without an id lost
 * focus on every change: Space on a "Show in overview" switch toggled it once,
 * and the next Space scrolled the page. No jsdom here, so `controlFor` is read
 * as text, as `card-editor-markup.test.ts` does: every input or select it
 * creates must be given an id before it is appended.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ts = readFileSync(new URL('../src/renderer/settings.ts', import.meta.url), 'utf8');

/** The source of `controlFor`, from its signature to the next top-level function. */
function controlForSource(): string {
  const start = ts.indexOf('function controlFor(');
  const end = ts.indexOf('\nfunction ', start + 1);
  return ts.slice(start, end);
}

describe('settings controls keep focus across a re-render', () => {
  it('renderSettings restores focus by id', () => {
    expect(ts).toMatch(/const focused = document\.activeElement\?\.id;/);
    expect(ts).toMatch(/document\.getElementById\(focused\)\?\.focus\(\)/);
  });

  it('every input and select controlFor creates gets an id', () => {
    const body = controlForSource();
    const created = [...body.matchAll(/const (\w+) = document\.createElement\('(input|select)'\)/g)].map(
      (m) => m[1] ?? ''
    );
    // toggle, choice, number, services, shortcut, and the three credit-price fields.
    expect(created.length).toBeGreaterThanOrEqual(8);
    for (const name of created) {
      expect(body, `${name} has no id`).toMatch(new RegExp(`\\b${name}\\.id = `));
    }
  });

  it('the per-service switches get distinct ids', () => {
    expect(controlForSource()).toMatch(/box\.id = idFor\(key, service\)/);
  });
});
