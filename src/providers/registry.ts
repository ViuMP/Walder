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
import { SERVICE_INFO, type ServiceMap } from '../core/services';
import {
  errorMessage,
  type AuthCheck,
  type ProviderResult,
  type ServiceName,
  type UsageProvider
} from './types';

/**
 * One chain per service, keyed by name.
 *
 * A record rather than a two-field interface, so everything below is written
 * over `Object.keys`/`Object.values` and a third service costs no edit in this
 * file at all — and so a test can hand in a chains object carrying a service
 * the app does not ship, which is what `ServiceMap`'s open index signature is
 * for.
 */
export type ProviderChains = ServiceMap<readonly UsageProvider[]>;

/** `via` for "we asked nobody, because there was nobody to ask". */
export const VIA_NONE = 'none';

/**
 * Try one chain and return the single result the panel should show for that
 * service. See the rule at the top of the file.
 */
export async function resolveService(
  service: string,
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
  return {
    buckets: [],
    status: 'unavailable',
    // A name outside `SERVICES` (a test's fake) gets a plain sentence rather
    // than a crash on `undefined.noLogin`; the poller hands us whatever keys
    // its chains object has.
    message: SERVICE_INFO[service as ServiceName]?.noLogin ?? `no ${service} login yet`,
    via: VIA_NONE
  };
}

/** Resolve every service in the chains. Run concurrently: they share no state. */
export async function resolveAll(
  chains: ProviderChains,
  now: Date
): Promise<ServiceMap<ProviderResult>> {
  const resolved = await Promise.all(
    Object.entries(chains).map(
      async ([service, providers]) =>
        // The keys of a chains record are the app's `SERVICES` in production
        // and a test's fakes otherwise; `resolveService` only needs the name to
        // pick a no-login message.
        [service, await resolveService(service as ServiceName, providers, now)] as const
    )
  );
  return Object.fromEntries(resolved) as ServiceMap<ProviderResult>;
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

/**
 * What the last authentication check for this service found, or `null` if none
 * has run yet this session.
 *
 * Synchronous, because the caller is an Electron `Menu` being built and cannot
 * await; and free of I/O, because a menu that polled the owner's account every
 * time he opened it would be both slow and rude. The web provider already made
 * the check — this only reads what it remembered.
 */
export function lastLoginCheck(
  providers: readonly UsageProvider[],
  service: ServiceName
): AuthCheck | null {
  return webProviderFor(providers, service)?.lastCheck?.() ?? null;
}

/** The chain for one service, by name. */
export function chainFor(chains: ProviderChains, service: ServiceName): readonly UsageProvider[] {
  return chains[service] ?? [];
}

/** Every provider in every chain, in chain order. For the tray's Accounts menu. */
export function allProviders(chains: ProviderChains): UsageProvider[] {
  return Object.values(chains).flat();
}
