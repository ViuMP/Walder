/**
 * Provider chains, and the ordering rule that picks one answer per service.
 *
 * Each service has several possible sources, best first. The rule:
 *
 *  1. Ask each provider in order, skipping any that says it is not available
 *     (no keychain item, no cookie) — an absent login is not a failure and must
 *     not be reported as one.
 *  2. The first `ok` wins and the rest are never called: no point asking
 *     claude.ai for numbers the CLI token already gave us, and every skipped
 *     provider is one fewer request against the owner's account.
 *  3. If nothing is `ok`, report the **last available** provider's result. Last,
 *     not first: the chain is ordered best-to-worst, so the deepest source that
 *     could actually be reached is the most informative thing to show — an
 *     "endpoint-changed" from claude.ai is more useful than "the CLI token
 *     expired" when both are true.
 *  4. If no provider was available at all, `unavailable` — the state that makes
 *     the tray offer "Log in…".
 *
 * A provider that *throws* is caught and turned into `error`. It still counts as
 * available: a source that blows up is a real problem and hiding it would leave
 * the panel silent about a service the owner has logged in to.
 *
 * Pure ordering logic, no electron and no network — the providers are injected,
 * which is what makes the whole table testable with fakes.
 */
import { errorMessage, type ProviderResult, type ServiceName, type UsageProvider } from './types';

export interface ProviderChains {
  readonly claude: readonly UsageProvider[];
  readonly chatgpt: readonly UsageProvider[];
}

/** `via` for "we asked nobody, because there was nobody to ask". */
export const VIA_NONE = 'none';

const NO_LOGIN_MESSAGE: Readonly<Record<ServiceName, string>> = {
  claude: 'no Claude login yet — use Accounts ▸ Claude ▸ Log in…',
  chatgpt: 'no ChatGPT login yet — use Accounts ▸ ChatGPT ▸ Log in…'
};

/**
 * Try one chain and return the single result the panel should show for that
 * service. See the rule at the top of the file.
 */
export async function resolveService(
  service: ServiceName,
  providers: readonly UsageProvider[],
  now: Date
): Promise<ProviderResult> {
  let lastAvailable: ProviderResult | null = null;

  for (const provider of providers) {
    let available: boolean;
    try {
      available = await provider.isAvailable();
    } catch (error) {
      // A broken availability check is itself worth surfacing, so it is treated
      // as "available, and failing" rather than silently skipped.
      lastAvailable = {
        buckets: [],
        status: 'error',
        message: errorMessage(error),
        via: provider.id
      };
      continue;
    }
    if (!available) continue;

    let result: ProviderResult;
    try {
      result = await provider.fetch(now);
    } catch (error) {
      result = { buckets: [], status: 'error', message: errorMessage(error), via: provider.id };
    }

    if (result.status === 'ok') return result;
    lastAvailable = result;
  }

  if (lastAvailable !== null) return lastAvailable;
  return { buckets: [], status: 'unavailable', message: NO_LOGIN_MESSAGE[service], via: VIA_NONE };
}

/** Resolve both services. Run concurrently: they share no state. */
export async function resolveAll(
  chains: ProviderChains,
  now: Date
): Promise<Record<ServiceName, ProviderResult>> {
  const [claude, chatgpt] = await Promise.all([
    resolveService('claude', chains.claude, now),
    resolveService('chatgpt', chains.chatgpt, now)
  ]);
  return { claude, chatgpt };
}

/**
 * The cookie-session provider in a chain, or `null` when there is none.
 *
 * Identified by "implements `isAuthenticated`" rather than by an id string:
 * that method is what makes a provider a web login (the token providers have no
 * such notion), so the two cannot drift apart the way a hardcoded id list
 * would.
 */
export function webProviderFor(
  providers: readonly UsageProvider[],
  service: ServiceName
): UsageProvider | null {
  return (
    providers.find((p) => p.service === service && p.isAuthenticated !== undefined) ?? null
  );
}

/**
 * Is the owner *authenticated* on this service's web login?
 *
 * The login window's close condition, and deliberately narrow. Two mistakes are
 * being avoided here, both of which closed the window while the login page was
 * still on screen:
 *
 *  1. asking the *whole chain* — with Claude Code or Codex installed, a token
 *     provider is available and says "logged in" about a service the browser
 *     session knows nothing about;
 *  2. asking `isAvailable` — that is a cookie-jar test, and chatgpt.com sets
 *     cookies on the login page itself.
 *
 * So: only the web provider for that service, and only its authenticated check
 * (a real request that has to come back with an organisation or an access
 * token). A throw is `false` — a failed check is not a login.
 */
export async function isWebLoginAuthenticated(
  providers: readonly UsageProvider[],
  service: ServiceName
): Promise<boolean> {
  const web = webProviderFor(providers, service);
  if (web?.isAuthenticated === undefined) return false;
  try {
    return await web.isAuthenticated();
  } catch {
    return false;
  }
}

/** The chain for one service, by name. */
export function chainFor(chains: ProviderChains, service: ServiceName): readonly UsageProvider[] {
  return service === 'claude' ? chains.claude : chains.chatgpt;
}

/** Every provider in both chains, in chain order. For the tray's Accounts menu. */
export function allProviders(chains: ProviderChains): UsageProvider[] {
  return [...chains.claude, ...chains.chatgpt];
}
