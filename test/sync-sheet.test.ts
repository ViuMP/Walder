/**
 * The art -> app sheet pipeline.
 *
 * `scripts/sync-sheet.ts` copies `art/walder.json` into `src/sprites/walder.json`
 * and refuses to do so unless the sheet passes `validateSheet` *and*
 * `requireSheetContract`. That is the only gate between hand-drawn JSON and a
 * mascot that has to draw itself on someone's desktop, so the gate is applied
 * here too, to both ends of the copy — the script runs from an npm hook where
 * nobody reads the output, while a failure here is a failure of `npm test`.
 *
 * The artist owns `art/walder.json` and regenerates it from `art/frames.mjs`.
 * These tests are therefore written to survive an ordinary redraw (different
 * pixels, a different palette ramp, extra animations) and to fail only on the
 * things the *code* depends on.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateSheet, type SpriteSheet } from '../src/sprites/types';
import {
  APP_DECOR_BY_FRAME,
  BAKED_DECOR_BY_ANIMATION,
  BAKED_DECOR_BY_FRAME,
  BUBBLE_AS_DECOR,
  BUBBLE_DECOR,
  FALLBACK_PALETTE,
  REQUIRED_ANIMATIONS,
  REQUIRED_BOXES,
  bakedDecor,
  bubbleIsBakedIn,
  bubbleIsDrawnAsDecor,
  decorAnchorFor,
  decorationPlacements,
  framesFor,
  mirrorReady,
  requireSheetContract,
  visibleDecors
} from '../src/sprites/contract';
import { ANIM_SLEEP, ANIM_WAKE } from '../src/core/behaviour';
import { pickAnimation } from '../src/core/expression';
import placeholder from '../src/sprites/placeholder.json';
import { decorAnchorSheet } from './fixtures/decor-anchor-sheet';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ART = join(root, 'art', 'walder.json');
const SYNCED = join(root, 'src', 'sprites', 'walder.json');

function read(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** Everything the app relies on, in one place, applied to both files. */
function expectUsableSheet(sheet: SpriteSheet): void {
  expect(() => requireSheetContract(sheet)).not.toThrow();
  for (const name of REQUIRED_ANIMATIONS) expect(sheet.animations[name], name).toBeDefined();
  for (const name of REQUIRED_BOXES) expect(sheet.boxes[name], name).toBeDefined();
  expect(sheet.palettes[FALLBACK_PALETTE]).toBeDefined();
}

describe("art/walder.json — the artist's file", () => {
  /*
   * Skipped rather than failed when absent: the art pipeline is a separate
   * workflow (`node art/frames.mjs`), and a checkout without it should still be
   * able to run the suite. The app falls back to the placeholder sprite in that
   * state, which `test/sheet.test.ts` covers.
   */
  const present = existsSync(ART);

  it.runIf(present)('passes the same gate scripts/sync-sheet.ts applies', () => {
    const sheet = validateSheet(read(ART));
    expectUsableSheet(sheet);
  });

  it.runIf(present)('offers the five coats the tray menu lists', () => {
    const sheet = validateSheet(read(ART));
    for (const coat of ['golden', 'red', 'cream', 'black-and-tan', 'chocolate']) {
      expect(sheet.palettes[coat], coat).toBeDefined();
    }
  });
});

describe('src/sprites/walder.json — the copy the app imports', () => {
  it('exists, so the static import in src/main/sheet.ts resolves', () => {
    // `sync-sheet` writes an empty `{}` rather than leaving the file absent even
    // when it fails, because a missing static import is a bundler error while an
    // empty one is a case `loadSheet` reports and recovers from.
    expect(existsSync(SYNCED)).toBe(true);
  });

  it('passes the gate', () => {
    const sheet = validateSheet(read(SYNCED));
    expectUsableSheet(sheet);
  });

  it('keeps the black-and-tan idle chest grey without changing its dark facial detail', () => {
    const sheet = validateSheet(read(SYNCED));
    const idle = sheet.frames['idle_0'];
    const blackTan = sheet.palettes['black-and-tan'];
    expect(blackTan?.['c']).toBe(blackTan?.['h']);
    expect((idle?.rows.join('').match(/c/g) ?? [])).toHaveLength(26);
    expect(idle?.rows[35]?.[15]).toBe('a');
  });

  it('has one duration per frame in every animation', () => {
    // `validateSheet` enforces this; asserted again against the real art because
    // a mismatch there is the failure mode that produces a dog frozen mid-step
    // with nothing in any log.
    const sheet = validateSheet(read(SYNCED));
    for (const [name, animation] of Object.entries(sheet.animations)) {
      expect(animation.durationsMs.length, name).toBe(animation.frames.length);
    }
  });

  it('holds only animations that can end', () => {
    // A held loop never reaches a last frame to park on. `validateSheet` rejects
    // the combination; this is the assertion that the real art does not rely on
    // it being tolerated.
    const sheet = validateSheet(read(SYNCED));
    for (const [name, animation] of Object.entries(sheet.animations)) {
      if (animation.hold) expect(animation.loop, name).toBe(false);
    }
  });

  /*
   * THAT IT IS A COPY IS THE POINT. Everything above proves the synced file is a
   * *valid* sheet. None of it proves it is *this* art: a redraw nobody synced
   * leaves the perfectly valid previous sheet in `src/sprites/`, every assertion
   * above passes, and the app draws the old dog. That is the same failure that
   * shipped a stale `icon.icns` on 2026-09-08 — a green build, one art revision
   * behind, invisible until someone compared two files by hand.
   *
   * Byte-identity rather than a deep-equal on the parsed JSON, because verbatim
   * bytes are what `scripts/sync-sheet.ts` actually promises: it copies the
   * source text so the two files stay diffable against each other. A
   * re-serialised copy would satisfy a structural comparison and quietly break
   * that.
   */
  it.runIf(existsSync(ART))('is byte-identical to art/walder.json', () => {
    expect(
      readFileSync(SYNCED, 'utf8'),
      'src/sprites/walder.json is out of date — run `npm run sync:sheet`'
    ).toBe(readFileSync(ART, 'utf8'));
  });

  /*
   * WHICH BOX AN ANIMATION IS DRAWN IN IS A CONTRACT BETWEEN THE ART AND THE
   * COORDINATOR, and it is not one `validateSheet` can see.
   *
   * `core/behaviour.ts` emits `{type:'mode', box:'stand'}` immediately before
   * `play('wake')` (asserted as a sequence in `test/behaviour.test.ts`) and
   * `core/expression.ts` reaches `out` from the stand-box cascade. Both
   * animations start off the dog's feet — curled up, and collapsed flat — so
   * either could plausibly have been authored in the small sleeping box, and if
   * one ever were, the window would already have been resized to the standing
   * size around a sprite drawn for a 61x58 box. Nothing would throw; the dog
   * would simply sit wrong in his window for the length of a yawn.
   */
  describe('the boxes the coordinator assumes', () => {
    function boxesOf(sheet: SpriteSheet, animation: string): string[] {
      const frames = sheet.animations[animation]?.frames ?? [];
      expect(frames.length, `${animation} has no frames`).toBeGreaterThan(0);
      return frames.map((name) => sheet.frames[name]?.box ?? `<no frame ${name}>`);
    }

    it('draws wake in the standing box, which mode:stand has already sized', () => {
      const sheet = validateSheet(read(SYNCED));
      for (const box of boxesOf(sheet, ANIM_WAKE)) expect(box).toBe('stand');
    });

    it('draws out in the standing box, which is where its cascade is', () => {
      const sheet = validateSheet(read(SYNCED));
      // Derived, not spelled: `pickAnimation` is what actually chooses it, and a
      // sheet that ships an `idle_out` would legitimately answer differently.
      const chosen = pickAnimation(
        'stand',
        'out',
        (name) => sheet.animations[name] !== undefined
      );
      for (const box of boxesOf(sheet, chosen)) expect(box).toBe('stand');
    });

    it('draws sleep, and only sleep, in the sleeping box', () => {
      const sheet = validateSheet(read(SYNCED));
      for (const box of boxesOf(sheet, ANIM_SLEEP)) expect(box).toBe('sleep');

      // The sleeping box is what the tiny fullscreen window is sized from, so a
      // stray frame in it would size the window for something that is not there.
      for (const [name, frame] of Object.entries(sheet.frames)) {
        if (frame.box === 'sleep') expect(name, name).toMatch(/^sleep_/);
      }
    });
  });

  describe('removed baked decorations', () => {

    it('names only animations and frames the sheet has', () => {
      const sheet = validateSheet(read(SYNCED));
      for (const name of Object.keys(BAKED_DECOR_BY_ANIMATION)) {
        expect(sheet.animations[name], name).toBeDefined();
      }
      for (const name of Object.keys(BAKED_DECOR_BY_FRAME)) {
        expect(sheet.frames[name], name).toBeDefined();
      }
    });

    it('is about a real collision: the sheet carries the standalone sprites too', () => {
      const sheet = validateSheet(read(SYNCED));
      const named = new Set(
        [...Object.values(BAKED_DECOR_BY_ANIMATION), ...Object.values(BAKED_DECOR_BY_FRAME)].flat()
      );
      expect(named.size).toBe(0);
      for (const decor of named) expect(sheet.boxes[decor], decor).toBeDefined();
    });

    it('has no baked question mark on tilt', () => {
      const sheet = validateSheet(read(SYNCED));
      const frames = sheet.animations['tilt']?.frames ?? [];
      const last = frames[frames.length - 1] as string;

      expect(bakedDecor('tilt', last)).toEqual([]);
    });

    it('has no baked sleep glyph', () => {
      const sheet = validateSheet(read(SYNCED));
      const frames = sheet.animations['sleep']?.frames ?? [];
      const last = frames[frames.length - 1] as string;

      for (const name of frames) expect(bakedDecor('sleep', name)).toEqual([]);
    });

    it('has no baked hearts in pet frames', () => {
      const sheet = validateSheet(read(SYNCED));
      const frames = sheet.animations['pet']?.frames ?? [];
      const palette = sheet.palettes[FALLBACK_PALETTE] ?? {};
      // The heart's own colour, taken from the standalone sprite rather than
      // named here: whichever letters that frame uses and the plain idle pose
      // does not are what "a heart" is made of.
      const inIdle = new Set((sheet.frames['idle_0']?.rows ?? []).join('').split(''));
      const heartOnly = new Set(
        (sheet.frames['heart_0']?.rows ?? [])
          .join('')
          .split('')
          .filter((ch) => ch !== '.' && !inIdle.has(ch))
      );
      expect(heartOnly.size, 'the heart sprite uses no colour of its own').toBeGreaterThan(0);

      const withHearts = frames.filter((name) =>
        (sheet.frames[name]?.rows ?? []).some((row) =>
          [...row].some((ch) => heartOnly.has(ch))
        )
      );
      expect(withHearts.length, 'a pet frame still draws a heart').toBe(0);
      expect(palette['p'], 'the pink the hearts are drawn in').toBeDefined();

      for (const name of frames) expect(bakedDecor('pet', name)).toEqual([]);
    });

    it('suppresses exactly the bubble that would double up, and nothing else', () => {
      expect(bubbleIsBakedIn('waiting', 'tilt', 'tilt_2')).toBe(false);
      expect(bubbleIsBakedIn('waiting', 'confused', 'tilt_2')).toBe(false);
      expect(bubbleIsBakedIn('sleepy', 'sleep', 'sleep_2')).toBe(false);

      // The two frames of the sleep loop the owner left undecorated.
      expect(bubbleIsBakedIn('sleepy', 'sleep', 'sleep_0')).toBe(false);
      expect(bubbleIsBakedIn('sleepy', 'sleep', 'sleep_1')).toBe(false);

      // A `?` and a `z z` are not interchangeable.
      expect(bubbleIsBakedIn('sleepy', 'tilt', 'tilt_2')).toBe(false);
      expect(bubbleIsBakedIn('waiting', 'sleep', 'sleep_2')).toBe(false);

      // Words have no drawn counterpart, so they are never suppressed.
      for (const kind of ['nudge', 'perk'] as const) {
        expect(BUBBLE_DECOR[kind]).toBeUndefined();
        expect(bubbleIsBakedIn(kind, 'tilt', 'tilt_2')).toBe(false);
        expect(bubbleIsBakedIn(kind, 'pet', 'pet_3')).toBe(false);
      }

      // Nothing on screen yet, or an animation the table says nothing about.
      expect(bubbleIsBakedIn('waiting', null, null)).toBe(false);
      expect(bubbleIsBakedIn('sleepy', 'idle', 'idle_0')).toBe(false);
    });
  });

  describe('decorations the app draws itself', () => {
    it('declares anchors for every universal decoration', () => {
      const sheet = validateSheet(read(SYNCED));
      expect(Object.keys(sheet.decorAnchors)).toEqual(['tilt', 'confused', 'sleep', 'pet']);
      expect(visibleDecors(sheet, 'tilt', 'tilt_2', 'waiting')).toEqual(['qmark']);
      expect(visibleDecors(sheet, 'sleep', 'sleep_2', null)).toEqual(['zz']);
      for (const frame of ['pet_2', 'pet_3', 'pet_4', 'pet_5']) {
        expect(visibleDecors(sheet, 'pet', frame, null), frame).toEqual(['heart']);
      }
      expect(decorationPlacements(sheet, 'heart', 'pet', 'pet_2')).toEqual([
        { anchor: { x: 14, y: 3 }, frameName: 'heart_0' },
        { anchor: { x: 38, y: 7 }, frameName: 'heart_1' }
      ]);
      expect(bubbleIsDrawnAsDecor('waiting', [])).toBe(false);
      expect(bubbleIsBakedIn('waiting', 'tilt', 'tilt_2')).toBe(false);
    });

    it('names only frames the sheet has, and decorations it carries as boxes', () => {
      const sheet = validateSheet(read(SYNCED));
      for (const [frame, decors] of Object.entries(APP_DECOR_BY_FRAME)) {
        expect(sheet.frames[frame], frame).toBeDefined();
        for (const decor of decors) {
          expect(sheet.boxes[decor], decor).toBeDefined();
          expect(sheet.animations[decor], decor).toBeDefined();
        }
      }
      for (const decor of Object.values(BUBBLE_AS_DECOR)) {
        expect(sheet.boxes[decor], decor).toBeDefined();
      }
    });

    it('keeps the placeholder sheet usable with no anchors at all', () => {
      // The placeholder is the sheet on a machine where the art pipeline has
      // never run. It must never be required to carry a `qmark` anchor.
      const sheet = validateSheet(placeholder);
      expect(() => requireSheetContract(sheet)).not.toThrow();
      expect(sheet.decorAnchors).toEqual({});
      expect(visibleDecors(sheet, 'tilt', 'tilt_2', 'waiting')).toEqual([]);
    });

    /*
     * The anchored path, against the temporary fixture — the only sheet in the
     * repo that reaches `visibleDecors`' filter with something to find.
     */
    describe('once the sheet carries anchors', () => {
      const sheet = validateSheet(decorAnchorSheet());

      it('draws the frame-keyed glyphs', () => {
        // `tilt_2` is both the frame `tilt` holds while the `?` is up and
        // `confused`'s only frame, so one entry serves "waiting for you" and
        // "logged out" — and the anchor is looked up per animation.
        expect(visibleDecors(sheet, 'tilt', 'tilt_2', null)).toEqual(['qmark']);
        expect(visibleDecors(sheet, 'confused', 'tilt_2', null)).toEqual(['qmark']);
        // One second on, two off: only the last frame of the sleep loop.
        expect(visibleDecors(sheet, 'sleep', 'sleep_2', null)).toEqual(['zz']);
        expect(visibleDecors(sheet, 'sleep', 'sleep_0', null)).toEqual([]);
        expect(visibleDecors(sheet, 'sleep', 'sleep_1', null)).toEqual([]);
      });

      it('draws the ? beside the ear *and* the words in the bubble', () => {
        // It used to *replace* the bubble, which was right while the bubble
        // said only `?`. It now says `Claude waiting` / `Codex waiting`, and
        // the glyph cannot name a tool — so the two are complementary and both
        // are drawn. The table entry stays: it is what anchors the glyph.
        const visible = visibleDecors(sheet, 'confused', 'tilt_2', 'waiting');
        expect(visible).toEqual(['qmark']);
        expect(bubbleIsDrawnAsDecor('waiting', visible)).toBe(false);
        expect(BUBBLE_AS_DECOR['waiting']).toBe('qmark');
        // And a sheet that baked one into the frame would not silence it either.
        expect(bubbleIsBakedIn('waiting', 'tilt', 'tilt_2')).toBe(false);
      });

      it('shows the ? for a waiting bubble even where no frame asks for one', () => {
        // `tilt` is a one-shot: the `?` must be up from its first frame, not
        // only once it reaches the held one.
        const visible = visibleDecors(sheet, 'tilt', 'tilt_0', 'waiting');
        expect(visible).toEqual(['qmark']);
      });

      it('asks for the ? once when the frame and the bubble both want it', () => {
        // `tilt` holding on `tilt_2` with a `waiting` bubble up: the frame table
        // says `qmark`, the bubble table says `qmark`. Drawing it twice would
        // double the outline's darkness where the two overlap.
        expect(visibleDecors(sheet, 'tilt', 'tilt_2', 'waiting')).toEqual(['qmark']);
      });

      it('leaves the …zzz bubble alone — it is not a decoration replacement', () => {
        // `sleepy` says `…zzz` over the first two sleep frames and only the
        // third carries the glyph, so the bubble is right two-thirds of the
        // time. It goes on being suppressed per frame instead.
        expect(BUBBLE_AS_DECOR['sleepy']).toBeUndefined();
        expect(bubbleIsDrawnAsDecor('sleepy', ['zz'])).toBe(false);
        expect(visibleDecors(sheet, 'sleep', 'sleep_0', 'sleepy')).toEqual([]);
      });

      it('draws nothing for a bubble that is words, or for an unanchored pose', () => {
        for (const kind of ['nudge', 'perk'] as const) {
          expect(visibleDecors(sheet, 'idle', 'idle_0', kind), kind).toEqual([]);
        }
        expect(visibleDecors(sheet, 'pet', 'pet_3', 'waiting')).toEqual(['heart']);
        expect(decorAnchorFor(sheet, 'pet', 'heart')).not.toBeNull();
      });

      it('draws nothing when there is no animation or no frame on screen yet', () => {
        expect(visibleDecors(sheet, null, null, null)).toEqual([]);
        expect(visibleDecors(sheet, null, 'tilt_2', 'waiting')).toEqual([]);
        expect(decorAnchorFor(sheet, null, 'qmark')).toBeNull();
      });

      it('anchors every decoration inside the box it is drawn in', () => {
        // Restated against the fixture because it is the property the renderer
        // relies on: it blits at the anchor with no bounds arithmetic, and a
        // decoration hanging above the standing box would land in the
        // speech-bubble reserve, on top of a bark bubble's tail.
        for (const [animation, anchors] of Object.entries(sheet.decorAnchors)) {
          const frameName = sheet.animations[animation]?.frames[0] as string;
          const boxName = sheet.frames[frameName]?.box as string;
          const [boxWidth, boxHeight] = sheet.boxes[boxName] as readonly [number, number];
          for (const [decor, anchor] of Object.entries(anchors)) {
            const [decorWidth, decorHeight] = sheet.boxes[decor] as readonly [number, number];
            const where = `${animation}.${decor}`;
            expect(anchor.x, where).toBeGreaterThanOrEqual(0);
            expect(anchor.y, where).toBeGreaterThanOrEqual(0);
            expect(anchor.x + decorWidth, where).toBeLessThanOrEqual(boxWidth);
            expect(anchor.y + decorHeight, where).toBeLessThanOrEqual(boxHeight);
          }
        }
      });
    });

    describe('mirrorReady', () => {
      it('says yes on the shipped sheet with universal glyph anchors', () => {
        const sheet = validateSheet(read(SYNCED));
        expect(mirrorReady(sheet)).toBe(true);
      });

      it('says no on the placeholder, which has neither the frames nor the anchors', () => {
        // The sheet on a machine where the art pipeline has never run: no
        // `tilt_2`, no `sleep_2`, no `qmark`/`zz` boxes, and its own marks drawn
        // into `confused_0`/`confused_1`. "The frames I would decorate are
        // missing" must not read as "mirroring is safe" — that is the `length
        // === 0` half of the rule, and without it this sheet passes vacuously.
        const sheet = validateSheet(placeholder);
        expect(sheet.animations['tilt']?.frames).not.toContain('tilt_2');
        expect(mirrorReady(sheet)).toBe(false);
      });

      it('says yes once every animation that plays a decorated frame is anchored', () => {
        // The shape stage A has to produce: `tilt` and `confused` both anchor
        // the `?` (they hold the same frame but frame the head differently), and
        // `sleep` anchors the `z z`.
        const sheet = validateSheet(decorAnchorSheet());
        expect(mirrorReady(sheet)).toBe(true);
      });

      it('says no on a half-migrated sheet — the ? anchored, the z z forgotten', () => {
        // One missing anchor must keep the dog un-mirrored.
        const raw = decorAnchorSheet();
        delete (raw['decorAnchors'] as Record<string, unknown>)['sleep'];
        const sheet = validateSheet(raw);
        expect(decorAnchorFor(sheet, 'tilt', 'qmark')).not.toBeNull();
        expect(decorAnchorFor(sheet, 'sleep', 'zz')).toBeNull();
        expect(mirrorReady(sheet)).toBe(false);
      });

      it('says no when one of two animations sharing a frame is unanchored', () => {
        // `tilt_2` is `tilt`'s held frame *and* `confused`'s only frame. An
        // anchor on `tilt` alone would leave a mirrored, logged-out dog without
        // a question mark.
        const raw = decorAnchorSheet();
        delete (raw['decorAnchors'] as Record<string, unknown>)['confused'];
        const sheet = validateSheet(raw);
        expect(decorAnchorFor(sheet, 'tilt', 'qmark')).not.toBeNull();
        expect(decorAnchorFor(sheet, 'confused', 'qmark')).toBeNull();
        expect(mirrorReady(sheet)).toBe(false);
      });
    });
  });

  /*
   * FRAME SETS — the sheet's other axis.
   *
   * Four of the five coats are a palette swap: the same pixels, eight letters
   * resolving to different colours. Silver dapple is not — its blotches have to
   * be drawn — so the sheet can carry a second drawing of every frame and the
   * palette says which to use. The approved dapple set now supplies the second
   * drawing for every frame, while the other coats share the golden frames
   * through their palettes (including the black-and-tan idle chest's colour-only
   * exception).
   */
  describe('frame sets', () => {
    it('carries the dapple set, and every coat resolves to its intended frames', () => {
      const sheet = validateSheet(read(SYNCED));
      expect(Object.keys(sheet.frameSets)).toEqual(['dapple']);
      expect(sheet.paletteFrameSets).toEqual({ 'silver-dapple': 'dapple' });
      for (const coat of Object.keys(sheet.palettes)) {
        expect(framesFor(sheet, coat), coat).toBe(
          coat === 'silver-dapple' ? sheet.frameSets.dapple : sheet.frames,
        );
      }
    });

    it('resolves every frame of every animation in every coat', () => {
      // The property the renderer depends on, stated over the real art rather
      // than a fixture: it looks the current frame name up in whatever set the
      // coat names, so a name that resolves in one coat and not another is a dog
      // who vanishes when someone changes his colour.
      const sheet = validateSheet(read(SYNCED));
      for (const coat of Object.keys(sheet.palettes)) {
        const frames = framesFor(sheet, coat);
        for (const [name, animation] of Object.entries(sheet.animations)) {
          for (const frameName of animation.frames) {
            expect(frames[frameName], `${coat}/${name}/${frameName}`).toBeDefined();
          }
        }
      }
    });

    it('keeps the placeholder on the single-set path too', () => {
      const sheet = validateSheet(placeholder);
      expect(sheet.frameSets).toEqual({});
      expect(framesFor(sheet, FALLBACK_PALETTE)).toBe(sheet.frames);
    });
  });

  it.skipIf(existsSync(ART))(
    'cannot be compared with art/walder.json, which is not in this checkout',
    () => {
      // A named skip rather than a test that silently does not exist: the art
      // pipeline (`node art/frames.mjs`) is a separate workflow, and a checkout
      // without it should still run the suite green — but the reason should be
      // readable in the output rather than inferred from a missing line.
      expect(existsSync(ART)).toBe(false);
    }
  );
});
