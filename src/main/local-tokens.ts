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
 * (`~/.codex` is `codexHome()`, so `$CODEX_HOME` is honoured as the hook
 * installer and the credential read honour it — audit P3.)
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
import { claudeTranscriptMessages, codexSessionTokens, localMidnight } from '../core/local-tokens';
import type { ServiceName } from '../core/services';
import { codexHome } from '../providers/credentials';
import { warn } from './log';

/** Only these are transcripts; the roots hold lock files and stray JSON too. */
const TRANSCRIPT_EXT = '.jsonl';

/** Claude Code's root, relative to the home directory. Codex's is `codexHome()/sessions`. */
const CLAUDE_ROOT = ['.claude', 'projects'] as const;

/**
 * What one file contributed — a total for Codex, a per-message map for Claude
 * so messages repeated across files are counted once — and the stat that says
 * the answer still holds.
 */
interface CachedFile {
  readonly mtimeMs: number;
  readonly size: number;
  readonly value: unknown;
}

const sum = (values: Iterable<number>): number => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

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
  opts: { home?: string; env?: Record<string, string | undefined>; now?: () => number } = {}
): LocalTokenScanner {
  const home = opts.home ?? homedir();
  const codexRoot = join(codexHome(opts.env ?? process.env, home), 'sessions');
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

  /** Each of one root's transcripts, read, or `null` when the root does not exist. */
  function scanRoot<T>(
    root: string,
    since: number,
    readLines: (lines: readonly string[], since: number) => T
  ): T[] | null {
    let names: string[];
    try {
      names = readdirSync(root, { recursive: true, encoding: 'utf8' });
    } catch {
      // Silently: a home without `~/.codex` is a machine without Codex, which
      // is an ordinary state of affairs and not a problem to report.
      return null;
    }

    const out: T[] = [];
    for (const name of names) {
      if (!name.endsWith(TRANSCRIPT_EXT)) continue;
      const path = join(root, name);
      try {
        const stat = statSync(path);
        // Nothing written since midnight can hold a line from today.
        if (!stat.isFile() || stat.mtimeMs < since) continue;

        const hit = cache.get(path);
        if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
          out.push(hit.value as T);
          continue;
        }

        const value = readLines(readFileSync(path, 'utf8').split('\n'), since);
        cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
        out.push(value);
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
    return out;
  }

  return {
    totals(): Partial<Record<ServiceName, number | null>> {
      const since = localMidnight(now());
      if (since !== cachedSince) {
        // Midnight rolled over: every memoised total counts yesterday's lines.
        cache.clear();
        cachedSince = since;
      }

      // Each Claude file is cached as its own message map and the maps are
      // merged per scan: a forked or copied session writes the same messages
      // into a second transcript (audit C1), so the dedupe has to span files.
      const claude = scanRoot(join(home, ...CLAUDE_ROOT), since, claudeTranscriptMessages);
      const chatgpt = scanRoot(codexRoot, since, codexSessionTokens);
      return {
        claude: claude === null ? null : sum(new Map(claude.flatMap((file) => [...file])).values()),
        chatgpt: chatgpt === null ? null : sum(chatgpt)
      };
    }
  };
}
