/**
 * The notification fallback's one decision, tested without a notification
 * centre anywhere near it.
 *
 * Two halves, and they fail differently. The *conditions* half is a promise to
 * the owner — nothing is posted while he can see the dog, and nothing is posted
 * at all unless he ticked the box — and breaking it means a mascot that talks
 * to Notification Centre about its own release notes. The *once* half is the
 * one a reader would not think to check: the coordinator re-sends the identical
 * bubble whenever the renderer reloads, so a gate with no memory would post a
 * second notification about a bark the owner has already read.
 */
import { describe, expect, it } from 'vitest';
import { createNoticeGate, type UnseenState } from '../src/core/notify';

const HIDDEN: UnseenState = { hidden: true, curled: false, enabled: true };
const CURLED: UnseenState = { hidden: false, curled: true, enabled: true };
const SEEN: UnseenState = { hidden: false, curled: false, enabled: true };

const BARK = { kind: 'nudge', text: '5-hour: 90% used' } as const;
const CLEAR = { kind: 'none', text: '' } as const;

describe('createNoticeGate — when it speaks at all', () => {
  it('speaks for a bark he cannot see, hidden or curled up', () => {
    expect(createNoticeGate()(BARK, HIDDEN)).toBe(true);
    expect(createNoticeGate()(BARK, CURLED)).toBe(true);
  });

  it('stays quiet while the dog is on screen saying it himself', () => {
    expect(createNoticeGate()(BARK, SEEN)).toBe(false);
  });

  it('stays quiet with the setting off, whatever else is true', () => {
    expect(createNoticeGate()(BARK, { ...HIDDEN, enabled: false })).toBe(false);
    expect(createNoticeGate()(BARK, { ...CURLED, enabled: false })).toBe(false);
  });

  it('speaks for a tool waiting on him, and for nothing else', () => {
    // `waiting` is a tool blocked until he answers; the rest keep until he next
    // looks at the dog.
    expect(createNoticeGate()({ kind: 'waiting', text: '?' }, HIDDEN)).toBe(true);
    expect(createNoticeGate()({ kind: 'perk', text: 'Claude is done' }, HIDDEN)).toBe(false);
    expect(createNoticeGate()({ kind: 'update', text: '0.2.7 is out' }, HIDDEN)).toBe(false);
    expect(createNoticeGate()({ kind: 'sleepy', text: '…zzz' }, HIDDEN)).toBe(false);
    expect(createNoticeGate()(CLEAR, HIDDEN)).toBe(false);
  });
});

describe('createNoticeGate — once per bark', () => {
  it('ignores the same bubble sent again, which is what a resync is', () => {
    const gate = createNoticeGate();
    expect(gate(BARK, HIDDEN)).toBe(true);
    expect(gate(BARK, HIDDEN)).toBe(false);
    expect(gate(BARK, HIDDEN)).toBe(false);
  });

  it('speaks again once the bubble cleared and the same fact came back', () => {
    // A later window crossing the same threshold is a new fact, not a repeat —
    // so the clear empties the memory rather than keeping the text.
    const gate = createNoticeGate();
    expect(gate(BARK, HIDDEN)).toBe(true);
    expect(gate(CLEAR, HIDDEN)).toBe(false);
    expect(gate(BARK, HIDDEN)).toBe(true);
  });

  it('treats a different number, or the same words under another kind, as new', () => {
    const gate = createNoticeGate();
    expect(gate(BARK, HIDDEN)).toBe(true);
    expect(gate({ kind: 'nudge', text: '5-hour: 95% used' }, HIDDEN)).toBe(true);
    expect(gate({ kind: 'waiting', text: '5-hour: 95% used' }, HIDDEN)).toBe(true);
  });

  it('remembers a bubble it stayed quiet about, so it cannot speak on the repeat', () => {
    // The bookkeeping runs on every bubble, not only the ones that fire: a bark
    // shown while he was visible must not become a notification when the
    // renderer reloads and the coordinator re-sends it.
    const gate = createNoticeGate();
    expect(gate(BARK, SEEN)).toBe(false);
    expect(gate(BARK, HIDDEN)).toBe(false);
  });
});
