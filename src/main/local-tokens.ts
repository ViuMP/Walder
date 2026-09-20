/**
 * Finding today's CLI transcripts on disk, and adding them up.
 *
 * The `fs` half of `core/local-tokens.ts`: that file knows how to read a line,
 * this one knows where the lines are. Two roots, both fixed by the CLIs
 * themselves:
 *
 *   ~/.claude/projects/<slugged project path>/<session>.jsonl   (Claude Code)
 *   ~/.codex/sessions/YYYY/MM/DD/<session>.jsonl                (Codex CLI)
 *
 * **A missing root means no row, never a zero.** Not everyone has both CLIs
 * installed, and "Tokens today: 0" under a Codex heading on a machine with no
 * Codex is a statement about an account, made confidently, and wrong. `null`
 * says "nothing to report" and the row simply does not appear — the same rule
 * `parseCodexCredits` and `parseExtraUsage` already follow for their own rows.
 *
 * ponytail: the IO here is synchronous, on the main process. At a three-minute
 * poll cadence over the handful of megabytes that *today's* files amount to
 * (the mtime filter throws away every older transcript before it is opened, and
 * the per-file cache re-reads only what changed since the last poll), the pause
 * is well under a frame and nobody sees it. If the card ever stutters on a
 * heavy day, the upgrade path is to move this scan to a worker or to
 * `fs/promises` and hand the poller a promise — the shape of `totals()` is the
 * only thing that would have to change.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeTranscriptTokens, codexSessionTokens, localMidnight } from '../core/local-tokens';
import type { ServiceName } from '../core/services';
import { warn } from './log';

/** Only these are transcripts; the roots hold lock files and stray JSON too. */
const TRANSCRIPT_EXT = '.jsonl';

/** The two roots, relative to the home directory. */
const CLAUDE_ROOT = ['.claude', 'projects'] as const;
const CODEX_ROOT = ['.codex', 'sessions'] as const;

/** What one file contributed, and the stat that says the answer still holds. */
interface CachedFile {
  readonly mtimeMs: number;
  readonly size: number;
  readonly total: number;
}

export interface LocalTokenScanner {
  /**
   * Tokens billed since local midnight, per service. `null` for a service
   * whose CLI is not installed on this machine.
   */
  totals(): Partial<Record<ServiceName, number | null>>;
}

/**
 * A scanner over the local transcripts.
 *
 * `home` and `now` are injectable for the tests, which build a fake home under
 * `os.tmpdir()` rather than reading the developer's real transcripts — a test
 * that asserts against this machine's actual token count would pass today and
 * fail tomorrow.
 */
export function createLocalTokenScanner(
  opts: { home?: string; now?: () => number } = {}
): LocalTokenScanner {
  const home = opts.home ?? homedir();
  const now = opts.now ?? ((): number => Date.now());

  /**
   * Per-file memo, so an unchanged transcript is parsed once rather than on
   * every poll. Keyed by path, validated by mtime *and* size: a session the
   * owner has not touched since the last poll is the overwhelming majority of
   * what the mtime filter lets through, because it lets through everything
   * touched since midnight.
   */
  const cache = new Map<string, CachedFile>();
  /** The `since` the cache was built against; a new one invalidates all of it. */
  let cachedSince: number | null = null;
  /** Paths already complained about, so a broken file warns once, not hourly. */
  const warned = new Set<string>();

  /** Sum one root's transcripts, or `null` when the root does not exist. */
  function scanRoot(
    root: string,
    since: number,
    countLines: (lines: readonly string[], since: number) => number
  ): number | null {
    let names: string[];
    try {
      names = readdirSync(root, { recursive: true, encoding: 'utf8' });
    } catch {
      // Silently: a home without `~/.codex` is a machine without Codex, which
      // is an ordinary state of affairs and not a problem to report.
      return null;
    }

    let total = 0;
    for (const name of names) {
      if (!name.endsWith(TRANSCRIPT_EXT)) continue;
      const path = join(root, name);
      try {
        const stat = statSync(path);
        // Nothing written since midnight can hold a line from today.
        if (!stat.isFile() || stat.mtimeMs < since) continue;

        const hit = cache.get(path);
        if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
          total += hit.total;
          continue;
        }

        const fileTotal = countLines(readFileSync(path, 'utf8').split('\n'), since);
        cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, total: fileTotal });
        total += fileTotal;
      } catch (error) {
        // One unreadable transcript must not cost the owner the other fifty.
        // Path and the error only — never a line of the file: transcripts are
        // full of his own prompts, and the log is written to disk.
        if (!warned.has(path)) {
          warned.add(path);
          warn(`could not read the local transcript ${path}:`, error);
        }
      }
    }
    return total;
  }

  return {
    totals(): Partial<Record<ServiceName, number | null>> {
      const since = localMidnight(now());
      if (since !== cachedSince) {
        // Midnight rolled over: every memoised total counts yesterday's lines.
        cache.clear();
        cachedSince = since;
      }

      return {
        // A fresh `seen` set per file, not per scan: the dedupe Claude Code
        // needs is between the repeated blocks of one message, which never
        // span two transcripts, and a scan-wide set would be wrong the moment
        // the cache returned a total without repopulating it.
        claude: scanRoot(join(home, ...CLAUDE_ROOT), since, (lines, from) =>
          claudeTranscriptTokens(lines, from, new Set<string>())
        ),
        chatgpt: scanRoot(join(home, ...CODEX_ROOT), since, codexSessionTokens)
      };
    }
  };
}
