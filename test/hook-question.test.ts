/** The hook confirmation box: Remove defaults to Cancel, Install to the action. */
import { describe, expect, it } from 'vitest';
import { hookQuestion } from '../src/main/hook-question';

const text = { cancel: 'Cancel', message: 'm', detail: 'd' };

describe('hookQuestion', () => {
  it('makes Cancel the default for Remove, so Return does not take the hooks out', () => {
    const q = hookQuestion({ ...text, remove: true, verb: 'Remove' });
    // Button 0 stays the action: the callers read `response === 0` as "do it".
    expect(q.buttons).toEqual(['Remove', 'Cancel']);
    expect(q.defaultId).toBe(1);
    expect(q.cancelId).toBe(1);
  });

  it('keeps the action as the default for Install', () => {
    const q = hookQuestion({ ...text, remove: false, verb: 'Install' });
    expect(q.buttons).toEqual(['Install', 'Cancel']);
    expect(q.defaultId).toBe(0);
    expect(q.cancelId).toBe(1);
  });
});
