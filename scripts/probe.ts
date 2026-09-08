/**
 * `npm run probe` — ask every provider what it can see, and print it.
 *
 * The owner's diagnostic. When the dog looks confused or the panel says a source
 * is broken, this is the one command that says *which* source, *why*, and what
 * numbers it did get — without launching the app, and with nothing to click.
 *
 * It runs the real providers outside Electron, which is exactly why the
 * providers take an injected `HttpFetch`: here it wraps Node's global `fetch`.
 * The two cookie-session providers cannot work outside the app (their login
 * lives in an Electron partition), so they are constructed with a `null` session
 * and report "needs the app's login session" instead of pretending to fail.
 *
 * **It never prints a token.** It prints statuses, messages, bucket labels,
 * percentages and reset timestamps. The one place a credential could surface is
 * an error message from `fetch`, so every printed line goes through the same
 * `redact` filter the app's logger uses.
 */
import { createClaudeOauthProvider } from '../src/providers/claude-oauth';
import { createClaudeWebProvider } from '../src/providers/claude-web';
import { createChatGptWebProvider } from '../src/providers/chatgpt-web';
import { createChatGptCodexProvider } from '../src/providers/chatgpt-codex';
import { fromFetch, type FetchLike } from '../src/providers/http';
import type { UsageProvider } from '../src/providers/types';
import { redact } from '../src/main/log';

const http = fromFetch(globalThis.fetch as unknown as FetchLike);

/** Print a line, redacted. Every `console` call in this file goes through here. */
function say(line = ''): void {
  console.log(redact(line));
}

const providers: UsageProvider[] = [
  createClaudeOauthProvider({ http }),
  // No Electron session out here: `isAvailable` is false and the result explains
  // why, rather than looking like a broken endpoint.
  createClaudeWebProvider({ session: () => null }),
  createChatGptWebProvider({ session: () => null }),
  createChatGptCodexProvider({ http })
];

async function probe(provider: UsageProvider): Promise<void> {
  say(`── ${provider.id}  (${provider.label}, ${provider.service})`);

  let available = false;
  try {
    available = await provider.isAvailable();
  } catch (error) {
    say(`   available: check failed — ${error instanceof Error ? error.message : 'unknown'}`);
  }
  say(`   available: ${available ? 'yes' : 'no'}`);

  const started = Date.now();
  const result = await provider.fetch(new Date());
  const ms = Date.now() - started;

  say(`   status:    ${result.status}  (${ms} ms)`);
  if (result.message !== undefined) say(`   message:   ${result.message}`);

  if (result.buckets.length === 0) {
    say('   buckets:   none');
    say();
    return;
  }

  say(`   buckets:   ${result.buckets.length}`);
  for (const bucket of result.buckets) {
    const pct = bucket.pct === null ? '   ?' : `${bucket.pct.toFixed(1).padStart(5)}%`;
    const resets = bucket.resetsAt ?? 'unknown';
    say(`     ${bucket.label.padEnd(22)} ${pct}   resets ${resets}`);
  }
  say();
}

async function main(): Promise<void> {
  say('Walder provider probe');
  say(`node ${process.version} on ${process.platform}`);
  say('No tokens are printed by this script.');
  say();

  for (const provider of providers) {
    try {
      await probe(provider);
    } catch (error) {
      // A provider that throws must not stop the rest of the report — the whole
      // point is to see every source in one run.
      say(`   FAILED:    ${error instanceof Error ? error.message : 'unknown error'}`);
      say();
    }
  }

  say('Done. `auth-needed` on claude-oauth is expected when the Claude Code');
  say('token has expired — Claude Code refreshes it the next time you use it.');
}

void main();
