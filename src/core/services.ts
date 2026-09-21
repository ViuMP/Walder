/**
 * The services Walder knows about, in one place.
 *
 * Until 0.2.5 the pair `'claude' | 'chatgpt'` was spelled out as a literal
 * union in eight files and read structurally (`.claude`, `.chatgpt`) in forty
 * more places, so a third service was ten edits and a silent fall-through
 * wherever a ternary assumed exactly two. Now it is one entry in `SERVICES`
 * plus one row in each table typed `Record<ServiceName, …>` — the compiler
 * names every row the new service still needs.
 *
 * A closed tuple rather than an open or branded string, on purpose: the IPC
 * validator (`isServiceName`) is a trust boundary that must reject anything
 * the app does not know, and `noUncheckedIndexedAccess` would otherwise turn
 * every `services.claude` read into a `| undefined`. `ServiceMap` is the
 * compromise: the known keys are always present, an arbitrary string is not.
 *
 * Electron-free — this is `src/core`.
 */
import { t } from './strings';

export const SERVICES = ['claude', 'chatgpt', 'cursor', 'copilot', 'gemini'] as const;

export type ServiceName = (typeof SERVICES)[number];

/**
 * A per-service record whose known keys are always present and whose unknown
 * keys read as `T | undefined` — so `map.claude` is a `T` and `map[someString]`
 * makes the caller check. Built with `perService`.
 */
export type ServiceMap<T> = Readonly<Record<ServiceName, T>> & { readonly [key: string]: T };

export function isServiceName(value: unknown): value is ServiceName {
  return typeof value === 'string' && (SERVICES as readonly string[]).includes(value);
}

/**
 * One record per name. The cast is the single place the open-keyed shape
 * meets the closed one: a caller that hands in `SERVICES` gets every known key.
 */
export function perService<T>(names: readonly string[], make: (service: string) => T): ServiceMap<T> {
  return Object.fromEntries(names.map((name) => [name, make(name)])) as ServiceMap<T>;
}

/** What the owner sees a service called: menu label, card heading, and the no-login remedy. */
export const SERVICE_INFO: Readonly<
  Record<ServiceName, { readonly label: string; readonly title: string; readonly noLogin: string }>
> = {
  claude: {
    label: t('services.claude.label'),
    title: t('services.claude.title'),
    noLogin: t('services.claude.noLogin')
  },
  chatgpt: {
    label: t('services.chatgpt.label'),
    title: t('services.chatgpt.title'),
    noLogin: t('services.chatgpt.noLogin')
  },
  cursor: {
    label: t('services.cursor.label'),
    title: t('services.cursor.title'),
    noLogin: t('services.cursor.noLogin')
  },
  copilot: {
    label: t('services.copilot.label'),
    title: t('services.copilot.title'),
    noLogin: t('services.copilot.noLogin')
  },
  gemini: {
    label: t('services.gemini.label'),
    title: t('services.gemini.title'),
    noLogin: t('services.gemini.noLogin')
  }
};
