/**
 * The preload bridge's *surface* — the exact list of things a renderer can say.
 *
 * This file is the attack-surface budget for the whole app, written down. The
 * renderer runs sandboxed under a strict CSP, but `contextBridge` is the one
 * hole through it, and the failure mode is silent and one-directional: widening
 * the bridge never breaks anything, so nothing fails when a convenience
 * `invoke(channel, ...)` or a bare `ipcRenderer` slips in during a refactor and
 * turns the fixed table into a general-purpose IPC client. Hence the exhaustive
 * key list below rather than a spot check — an added key must fail here and be
 * argued for, not merely appear.
 *
 * Three more things it pins, each with its own way of going wrong:
 *  - **Channel wiring.** Every call goes to the channel in `CH` its name claims.
 *    A `login` bound to `CH.authLogout` would compile, typecheck, and log the
 *    owner out when they tried to log in.
 *  - **Unsubscribe really unsubscribes.** `subscribe` closes over the wrapper it
 *    registered, and `removeListener` must be handed *that* function, not the
 *    caller's callback — the near-miss that removes nothing, leaks a listener
 *    per re-subscribe, and is invisible until a component remounts.
 *  - **The `.d.ts` is checked against the runtime.** `src/preload/index.d.ts` is
 *    what the renderer's own tsconfig believes, and nothing typechecks it
 *    against the implementation, so the two can drift into a method the
 *    renderer can call and the preload does not have.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const host = vi.hoisted(() => ({
  /** Every `exposeInMainWorld` call, in order. */
  exposed: [] as { key: string; api: Record<string, unknown> }[],
  /** `ipcRenderer.on` registrations. */
  on: [] as { channel: string; listener: (...args: unknown[]) => void }[],
  /** `ipcRenderer.removeListener` calls. */
  off: [] as { channel: string; listener: (...args: unknown[]) => void }[],
  /** `ipcRenderer.invoke` calls, arguments and all. */
  invoked: [] as unknown[][]
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: Record<string, unknown>): void => {
      host.exposed.push({ key, api });
    }
  },
  ipcRenderer: {
    invoke: async (...args: unknown[]): Promise<unknown> => {
      host.invoked.push(args);
      return undefined;
    },
    on: (channel: string, listener: (...args: unknown[]) => void): void => {
      host.on.push({ channel, listener });
    },
    removeListener: (channel: string, listener: (...args: unknown[]) => void): void => {
      host.off.push({ channel, listener });
    }
  }
}));

// Imported for its side effect: the module *is* the `exposeInMainWorld` call.
await import('../src/preload/index');
const { CH } = await import('../src/main/ipc');

/** The bridge object the renderer would see as `window.walder`. */
const api = (host.exposed[0]?.api ?? {}) as Record<string, (...args: unknown[]) => unknown>;

/**
 * The whole surface, spelled out. Sorted, so a new key cannot be hidden by
 * appending it, and deliberately a literal rather than derived from the module.
 */
const SURFACE: readonly string[] = [
  'dragEnd',
  'dragMove',
  'dragStart',
  'getSettings',
  'hoverEnter',
  'hoverLeave',
  'login',
  'logout',
  'onCardSize',
  'onFacing',
  'onHitResync',
  'onMode',
  'onPalette',
  'onScene',
  'onSheet',
  'onUsage',
  'openMenu',
  'pet',
  'refreshNow',
  'reportPanelSize',
  'setHit'
];

/** Each call out, and the channel its name promises. */
const CALLS: readonly { name: string; channel: string; args: unknown[] }[] = [
  { name: 'getSettings', channel: CH.settingsGet, args: [] },
  { name: 'setHit', channel: CH.hitSet, args: [true] },
  { name: 'dragStart', channel: CH.dragStart, args: [] },
  { name: 'dragMove', channel: CH.dragMove, args: [3, 4] },
  { name: 'dragEnd', channel: CH.dragEnd, args: [] },
  { name: 'pet', channel: CH.pet, args: [] },
  { name: 'openMenu', channel: CH.menuOpen, args: [] },
  {
    name: 'hoverEnter',
    channel: CH.hoverEnter,
    args: [{ x: 1, y: 2, width: 3, height: 4 }]
  },
  { name: 'hoverLeave', channel: CH.hoverLeave, args: [] },
  { name: 'refreshNow', channel: CH.refreshNow, args: [] },
  { name: 'login', channel: CH.authLogin, args: ['claude'] },
  { name: 'logout', channel: CH.authLogout, args: ['chatgpt'] },
  { name: 'reportPanelSize', channel: CH.panelSize, args: [300] }
];

/** Each subscription, and the channel it must listen on. */
const SUBSCRIPTIONS: readonly { name: string; channel: string }[] = [
  { name: 'onSheet', channel: CH.sheetSet },
  { name: 'onMode', channel: CH.modeSet },
  { name: 'onPalette', channel: CH.paletteSet },
  { name: 'onHitResync', channel: CH.hitResync },
  { name: 'onFacing', channel: CH.facingSet },
  { name: 'onCardSize', channel: CH.cardSizeSet },
  { name: 'onUsage', channel: CH.usageUpdate },
  { name: 'onScene', channel: CH.scene }
];

function call(name: string, ...args: unknown[]): unknown {
  const fn = api[name];
  if (fn === undefined) throw new Error(`the bridge has no "${name}"`);
  return fn(...args);
}

beforeEach(() => {
  host.on = [];
  host.off = [];
  host.invoked = [];
});

describe('what the preload exposes', () => {
  it('exposes exactly one bridge, under the key walder', () => {
    expect(host.exposed.map((entry) => entry.key)).toEqual(['walder']);
  });

  it('exposes exactly the 21 documented members and nothing more', () => {
    expect(Object.keys(api).sort()).toEqual([...SURFACE].sort());
  });

  it('exposes only functions', () => {
    for (const [name, value] of Object.entries(api)) {
      expect(typeof value, `${name} is not a function`).toBe('function');
    }
  });

  it('exposes no generic IPC escape hatch', () => {
    for (const forbidden of ['invoke', 'send', 'on', 'ipcRenderer', 'removeListener']) {
      expect(Object.keys(api)).not.toContain(forbidden);
    }
  });
});

describe('calls out', () => {
  it.each(CALLS)('$name invokes $channel', async ({ name, channel, args }) => {
    await call(name, ...args);
    expect(host.invoked).toHaveLength(1);
    expect(host.invoked[0]?.[0]).toBe(channel);
  });

  it('wraps each argument in the record shape the validators expect', async () => {
    await call('setHit', true);
    await call('dragMove', 3, 4);
    await call('login', 'claude');
    await call('reportPanelSize', 300);
    expect(host.invoked.map((entry) => entry[1])).toEqual([
      { inside: true },
      { dxScreen: 3, dyScreen: 4 },
      { service: 'claude' },
      { height: 300 }
    ]);
  });
});

describe('subscriptions in', () => {
  it.each(SUBSCRIPTIONS)('$name listens on $channel', ({ name, channel }) => {
    call(name, () => {});
    expect(host.on.map((entry) => entry.channel)).toEqual([channel]);
  });

  it.each(SUBSCRIPTIONS)(
    '$name returns an unsubscribe that removes the listener it registered',
    ({ name, channel }) => {
      const unsubscribe = call(name, () => {}) as () => void;
      unsubscribe();
      // The identity is the point: removing the *callback* rather than the
      // wrapper would remove nothing and leak on every re-subscribe.
      expect(host.off).toEqual([{ channel, listener: host.on[0]?.listener }]);
    }
  );

  it.each(SUBSCRIPTIONS.filter((entry) => entry.name !== 'onHitResync'))(
    '$name forwards the payload and swallows the event object',
    ({ name }) => {
      const seen: unknown[] = [];
      call(name, (payload: unknown) => seen.push(payload));
      host.on[0]?.listener({ senderId: 0 }, { marker: 'payload' });
      expect(seen).toEqual([{ marker: 'payload' }]);
    }
  );

  it('calls an onHitResync subscriber with no argument, since the channel carries none', () => {
    const seen: unknown[][] = [];
    call('onHitResync', (...args: unknown[]) => seen.push(args));
    host.on[0]?.listener({ senderId: 0 }, undefined);
    expect(seen).toEqual([[]]);
  });
});

describe('the ambient declaration', () => {
  /**
   * `index.d.ts` is hand-maintained and never compiled against the
   * implementation, so it is read as text. The regex matches a member line
   * inside the `WalderApi` block — `name(` for a method, `name:` for a
   * property — which is robust to the JSDoc between them (a comment line starts
   * with `/` or `*`, neither of which is a word character).
   */
  function declaredMembers(): string[] {
    const source = readFileSync(
      fileURLToPath(new URL('../src/preload/index.d.ts', import.meta.url)),
      'utf8'
    );
    const start = source.indexOf('export interface WalderApi {');
    if (start === -1) throw new Error('WalderApi is not declared in index.d.ts');
    const body = source.slice(start).split(/^}/m)[0] ?? '';
    return [...body.matchAll(/^\s+(\w+)\s*[(:]/gm)].map((match) => match[1] as string);
  }

  it('declares the same members the preload actually exposes', () => {
    expect([...new Set(declaredMembers())].sort()).toEqual(Object.keys(api).sort());
  });
});
