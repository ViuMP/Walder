/**
 * The oversized-hook-body reader: three fields off the head of a body too
 * large to accept whole, by bounded regex and never by a JSON parse.
 *
 * It exists because a real Claude Code `PostToolUse` carried a large file read
 * in `tool_response` and was refused 413 (0.2.8 QA). The cases pinned here are
 * the ones a regex gets wrong if it is written carelessly: escaped quotes, key
 * order, missing fields, a string's contents posing as a key, and a value past
 * the detail cap.
 */
import { describe, expect, it } from 'vitest';
import { MAX_DETAIL_CHARS, hookHeadFrom } from '../src/core/hook-head';

/** A head as the listener sees it: the start of a body, cut off mid-field. */
const CUT = ',"tool_response":{"content":"xxxxxxxx';

describe('hookHeadFrom', () => {
  it('reads Claude Code’s own order, cut off inside the tool fields', () => {
    const head =
      '{"session_id":"abc-123","transcript_path":"/t.jsonl","cwd":"/Users/someone/code",' +
      '"hook_event_name":"PostToolUse","tool_name":"Read"' +
      CUT;
    expect(hookHeadFrom(head)).toEqual({
      event: 'PostToolUse',
      session_id: 'abc-123',
      cwd: '/Users/someone/code'
    });
  });

  it('takes the keys in any order, and whitespace around the colon', () => {
    const head = '{ "hook_event_name" : "Stop", "cwd": "/a", "session_id" :"s"' + CUT;
    expect(hookHeadFrom(head)).toEqual({ event: 'Stop', session_id: 's', cwd: '/a' });
  });

  it('prefers `event` over `hook_event_name`, as a parsed body does', () => {
    expect(hookHeadFrom('{"hook_event_name":"Stop","event":"Notification"' + CUT)).toEqual({
      event: 'Notification'
    });
  });

  it('undoes escapes, including an escaped quote', () => {
    const head = JSON.stringify({ hook_event_name: 'Stop', cwd: 'C:\\Users\\a "b"' }) + CUT;
    expect(hookHeadFrom(head)?.cwd).toBe('C:\\Users\\a "b"');
  });

  it('leaves out an optional field that is missing, or not a string', () => {
    expect(hookHeadFrom('{"hook_event_name":"Stop","cwd":17' + CUT)).toEqual({ event: 'Stop' });
  });

  it('does not take a key out of a string’s contents', () => {
    // The string holds `"cwd": "/fake"` — escaped, so not a member.
    const head = JSON.stringify({ hook_event_name: 'Stop', note: ',"cwd":"/fake"' }) + CUT;
    expect(hookHeadFrom(head)).toEqual({ event: 'Stop' });
    // The sly one: a key ending in `"cwd` serialises to `"say \"cwd":"/fake"`,
    // whose tail is a bare `"cwd":"` — only the `{`/`,` anchor refuses it.
    const sly = JSON.stringify({ hook_event_name: 'Stop', 'say "cwd': '/fake' }) + CUT;
    expect(hookHeadFrom(sly)).toEqual({ event: 'Stop' });
  });

  it('drops a value past the detail cap rather than truncating it', () => {
    const long = '/'.repeat(MAX_DETAIL_CHARS + 1);
    expect(hookHeadFrom(`{"hook_event_name":"Stop","cwd":"${long}"` + CUT)).toEqual({
      event: 'Stop'
    });
  });

  it('is null when no event is named, or the head is not an object', () => {
    expect(hookHeadFrom('{"session_id":"abc","cwd":"/a"' + CUT)).toBeNull();
    expect(hookHeadFrom('{"hook_event_name":"Pre Tool"' + CUT)).toBeNull();
    expect(hookHeadFrom('[{"hook_event_name":"Stop"}')).toBeNull();
    expect(hookHeadFrom('aaaa')).toBeNull();
    expect(hookHeadFrom('')).toBeNull();
  });
});
