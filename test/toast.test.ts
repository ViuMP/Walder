/**
 * `main/toast.ts`: every toast attempt and its outcome leaves a log line
 * (Windows QA 9.23: a missed toast left none), and no line carries the bark's
 * text, which holds the owner's percentages.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ Notification: class {} }));

import { setLogSink } from '../src/main/log';
import { liveToasts, postToast, type ToastClass } from '../src/main/toast';

const BODY = 'Claude 5h: 91% used';

/** A fake `Notification` class that records what it was given. */
function fakeToasts(supported = true): { Toast: ToastClass; made: FakeToast[] } {
  const made: FakeToast[] = [];
  class FakeToast extends EventEmitter {
    shown = 0;
    constructor(readonly options: Electron.NotificationConstructorOptions) {
      super();
      made.push(this);
    }
    static isSupported(): boolean {
      return supported;
    }
    show(): void {
      this.shown += 1;
    }
  }
  return { Toast: FakeToast as unknown as ToastClass, made };
}
type FakeToast = EventEmitter & {
  shown: number;
  options: Electron.NotificationConstructorOptions;
};

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  setLogSink((line) => lines.push(line));
});
afterEach(() => setLogSink(null));

describe('postToast', () => {
  it('posts a silent toast titled Walder and logs posting, shown and clicked', () => {
    const { Toast, made } = fakeToasts();
    postToast('nudge', BODY, Toast);
    expect(made).toHaveLength(1);
    expect(made[0]?.options).toEqual({ title: 'Walder', body: BODY, silent: true });
    expect(made[0]?.shown).toBe(1);
    made[0]?.emit('show');
    made[0]?.emit('click');
    expect(lines.join('')).toMatch(/nudge bark: posting[\s\S]*nudge bark: shown[\s\S]*nudge bark: clicked/);
  });

  it('logs a failure as a warning', () => {
    const { Toast, made } = fakeToasts();
    postToast('waiting', BODY, Toast);
    made[0]?.emit('failed', {}, 'the system refused');
    expect(lines.some((line) => line.includes('WARN') && line.includes('waiting bark: failed'))).toBe(true);
  });

  it('holds each toast until it closes or fails, so its listeners survive', () => {
    const { Toast, made } = fakeToasts();
    const before = liveToasts();
    postToast('nudge', BODY, Toast);
    postToast('nudge', BODY, Toast);
    expect(liveToasts()).toBe(before + 2);
    made[0]?.emit('close');
    made[1]?.emit('failed', {}, 'x');
    expect(liveToasts()).toBe(before);
  });

  it('logs rather than throws where toasts are not supported', () => {
    const { Toast, made } = fakeToasts(false);
    postToast('nudge', BODY, Toast);
    expect(made).toHaveLength(0);
    expect(lines.join('')).toContain('not supported');
  });

  it('never writes the bark text or a percentage', () => {
    const { Toast, made } = fakeToasts();
    postToast('nudge', BODY, Toast);
    made[0]?.emit('show');
    made[0]?.emit('click');
    made[0]?.emit('close');
    expect(lines.length).toBeGreaterThan(0);
    // The timestamp in front of each line is the logger's, and can hold a 91.
    const said = lines.map((line) => line.replace(/^\S+ /, '')).join('');
    expect(said).not.toMatch(/91|%|Claude 5h/);
  });
});
