/**
 * No log call in the main process or the providers passes a response body.
 *
 * `log.ts` redacts tokens by pattern, and `test/log-redaction.test.ts` pins
 * that filter. This is the other half: the filter is a backstop, and the rule
 * it backs is that a body — the owner's usage payload, a login page, whatever
 * came back — never reaches a log call in the first place. `topLevelKeys(json)`
 * is allowed (the redaction doc calls a key list the only loggable thing about a
 * body), and so is a `.length` (a size is a shape, not a value).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['src/providers', 'src/main'];
const LOGGERS = /\b(vlog|info|warn|error)\(/g;
/** A body reaching the arguments, after the allowed forms are stripped. */
const BODY = /\bbody\b|\.text\(\)|\bjson\b|JSON\.stringify\(/;
const ALLOWED = /\b(?:body|json)\.length\b|topLevelKeys\((?:json|body)\)/g;

function sources(): string[] {
  return ROOTS.flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(root, name))
  );
}

/**
 * String literals go, so `'walder.json'` is not a body; a template literal is
 * replaced by its `${…}` parts alone, so a body interpolated into a message
 * still counts.
 */
function withoutLiterals(args: string): string {
  return args
    .replace(/`([^`]*)`/g, (_, inner: string) =>
      Array.from(inner.matchAll(/\$\{([^}]*)\}/g), (m) => ` ${m[1]} `).join('')
    )
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
}

/** The argument text of the call whose `(` is at `open`, across lines. */
function argumentsFrom(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/** Every log call in `text` whose arguments reach a body, as `file:line: call`. */
function offendersIn(file: string, text: string): string[] {
  const offenders: string[] = [];
  for (const match of text.matchAll(LOGGERS)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const args = withoutLiterals(argumentsFrom(text, open)).replace(ALLOWED, '');
    if (BODY.test(args)) {
      const line = text.slice(0, match.index).split('\n').length;
      offenders.push(`${file}:${line}: ${match[0]}${args.trim().slice(0, 80)}`);
    }
  }
  return offenders;
}

describe('log calls in src/providers and src/main', () => {
  it('never pass a response body', () => {
    const offenders = sources().flatMap((file) => offendersIn(file, readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('would catch one', () => {
    // The scanner's own check: a body in a plain argument, in a template
    // interpolation, and via `.text()` are all caught; a key list, a length,
    // and a file name that happens to end in `.json` are not.
    const bad = [
      "vlog('payload', json)",
      'warn(`got ${response.body}`)',
      'info(await response.text())',
      'error(JSON.stringify(json))'
    ];
    const fine = [
      "vlog('keys', topLevelKeys(json))",
      "warn('body was', body.length, 'bytes')",
      "warn('src/sprites/walder.json holds no artwork')"
    ];
    expect(offendersIn('x.ts', bad.join('\n'))).toHaveLength(bad.length);
    expect(offendersIn('x.ts', fine.join('\n'))).toEqual([]);
  });

  it('found the loggers it is policing', () => {
    const calls = sources().reduce(
      (count, file) => count + (readFileSync(file, 'utf8').match(LOGGERS)?.length ?? 0),
      0
    );
    expect(calls).toBeGreaterThan(50);
  });
});
