/**
 * The rotating log file behind `setLogSink`.
 *
 * Walder has no terminal and no window. When something goes wrong — a login that
 * will not take, a dog that never perks, numbers that stopped updating — the only
 * evidence that can survive until the owner mentions it is a file on his disk.
 * So `warn` always writes here, and `vlog` writes here too once he ticks tray ▸
 * Developer ▸ Verbose log.
 *
 * Design notes, in the order they matter:
 *
 *  - **Bounded, because nobody will ever delete it.** Three files of a megabyte
 *    is the cap: enough to hold days of warnings or an hour of verbose tracing,
 *    small enough that it can be forgotten about forever and small enough to
 *    attach to a message. `walder.log` is the live one, `walder.1.log` the
 *    previous, `walder.2.log` the oldest; the fourth is deleted.
 *  - **Synchronous appends.** `appendFileSync` per line, not a write stream. Log
 *    volume here is a handful of lines a minute, so the cost is irrelevant, and
 *    the alternative loses the last and most interesting lines exactly when they
 *    matter most: a stream's buffer is discarded if the process dies, and a crash
 *    is precisely when someone reads this file.
 *  - **Never throws.** A full disk, a logs directory the OS moved, a file
 *    someone opened exclusively — none of that may take down a mascot, and none
 *    of it may recurse back into `warn`. Every entry point swallows its errors and
 *    the sink simply goes quiet (`failed`), so a broken disk costs the logging and
 *    nothing else.
 *  - **Redaction happened upstream.** `log.ts` has already run every argument
 *    through `redact` before the line reaches this file. This module must never be
 *    handed a raw value to format, and it does not know how to.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Rotate once the live file passes this size. */
export const MAX_BYTES = 1_024 * 1_024;

/**
 * How many files exist at most: the live one plus two older generations. Named
 * for the owner-facing promise ("1 MB x 3"), not for the number of renames.
 */
export const MAX_FILES = 3;

/** The live file's name inside the logs directory. */
export const LOG_NAME = 'walder.log';

export interface FileLog {
  /** Absolute path of the live file. */
  readonly path: string;
  /** Append one already-redacted, already-newline-terminated line. */
  write(line: string): void;
}

export interface FileLogOptions {
  /** Directory to write into. `app.getPath('logs')` in the app. */
  readonly dir: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}

/** `walder.log`, `walder.1.log`, `walder.2.log`, … */
function generationPath(dir: string, index: number): string {
  return index === 0 ? join(dir, LOG_NAME) : join(dir, `walder.${index}.log`);
}

/** Size of `path`, or 0 if it does not exist (or cannot be read). */
function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Shuffle the generations along: the oldest is deleted, then each file is
 * renamed one number older, oldest first so nothing is overwritten before it has
 * moved.
 *
 * Exported for the unit test, which is the only way to see this happen without
 * writing a megabyte.
 */
export function rotate(dir: string, maxFiles: number): void {
  const oldest = maxFiles - 1;
  try {
    rmSync(generationPath(dir, oldest), { force: true });
  } catch {
    // An undeletable oldest generation just means the rename below fails too,
    // and the next write finds the live file still oversized and tries again.
  }
  for (let index = oldest - 1; index >= 0; index--) {
    const from = generationPath(dir, index);
    if (sizeOf(from) === 0) continue;
    try {
      renameSync(from, generationPath(dir, index + 1));
    } catch {
      // Leave it; see above.
    }
  }
}

/**
 * Open (or rather, prepare) the rotating log.
 *
 * Creating the directory is the one thing done eagerly, because it is the only
 * failure worth knowing about immediately and it is cheap. Everything else is
 * lazy: no handle is held, so an app that logs nothing touches no file.
 */
export function createFileLog(options: FileLogOptions): FileLog {
  const { dir } = options;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const maxFiles = Math.max(1, options.maxFiles ?? MAX_FILES);
  const path = generationPath(dir, 0);

  let failed = false;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    failed = true;
  }

  /** Bytes in the live file, tracked so a `stat` is not needed per line. */
  let size = failed ? 0 : sizeOf(path);

  function write(line: string): void {
    if (failed) return;
    const bytes = Buffer.byteLength(line, 'utf8');
    try {
      // Rotate *before* writing, so no single file ever exceeds the cap by more
      // than the line that crossed it.
      if (size + bytes > maxBytes && size > 0) {
        rotate(dir, maxFiles);
        size = 0;
      }
      appendFileSync(path, line, 'utf8');
      size += bytes;
    } catch {
      // Go quiet rather than throw: a log line must never be the reason the
      // mascot stops, and `warn`ing about a failed `warn` would recurse.
      failed = true;
    }
  }

  return { path, write };
}
