/**
 * The Walder window's renderer: two screens behind a tab bar.
 *
 *  - **Overview** draws the hover card's model with the card's own painter
 *    (`card-dom.ts`), at the Large layout, from the same filtered snapshot the
 *    card gets, plus a Refresh button that is the tray's Refresh.
 *  - **Settings** draws one control per entry in `core/settings-spec` and
 *    saves each change as it is made, the way the tray does. Main validates
 *    again (the spec's own `validate`) and answers with the whole new state,
 *    which is what the screen then shows, so a refused value snaps back and a
 *    change made in the tray menu while the window is open appears here too.
 */
import {
  SETTINGS,
  SETTING_GROUPS,
  type SettingKey,
  type SettingSpec,
  type UserSettings
} from '../core/settings-spec';
import { SERVICES } from '../core/services';
import { SERVICE_LABELS, cardRowsFor } from '../core/card-layout';
import { shortcutStatusLine } from '../core/shortcuts';
import type { SettingsWindowState } from '../main/settings-ipc';
import { el, paint } from './card-dom';

const api = window.walderSettings;
let state: SettingsWindowState | null = null;
/** Per-key message under the control: an error, or "Saved". */
const messages = new Map<SettingKey, { text: string; kind: 'error' | 'saved' | 'note' }>();

/* ----------------------------------------------------------------- tabs */

const tabs = ['overview', 'settings'] as const;
function select(screen: (typeof tabs)[number]): void {
  for (const name of tabs) {
    const tab = document.getElementById(`tab-${name}`);
    const panel = document.getElementById(`screen-${name}`);
    tab?.setAttribute('aria-selected', String(name === screen));
    tab?.setAttribute('tabindex', name === screen ? '0' : '-1');
    if (panel !== null) panel.hidden = name !== screen;
  }
}
for (const name of tabs) {
  document.getElementById(`tab-${name}`)?.addEventListener('click', () => select(name));
}
document.querySelector('[role="tablist"]')?.addEventListener('keydown', (event) => {
  const key = (event as KeyboardEvent).key;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
  const current = tabs.findIndex(
    (name) => document.getElementById(`tab-${name}`)?.getAttribute('aria-selected') === 'true'
  );
  const next = tabs[(current + (key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length] ?? 'overview';
  select(next);
  document.getElementById(`tab-${next}`)?.focus();
});
// A deep link for screenshots and the on-screen check: settings.html#settings.
select(window.location.hash === '#settings' ? 'settings' : 'overview');

/* ------------------------------------------------------------- overview */

function renderOverview(): void {
  const card = document.getElementById('card');
  if (card === null || state === null) return;
  paint(
    card,
    cardRowsFor(
      state.usage,
      'large',
      Date.now(),
      navigator.language,
      state.creditPrice,
      state.settings.resetStyle,
      state.sessions
    )
  );
}

const refreshButton = document.getElementById('refresh') as HTMLButtonElement | null;
const refreshStatus = document.getElementById('refresh-status');
refreshButton?.addEventListener('click', () => {
  void api.refresh().then((started) => {
    if (refreshStatus !== null) {
      refreshStatus.textContent = started
        ? 'Checking every service now.'
        : 'Asked a moment ago. Try again in a minute.';
    }
  });
});

/* ------------------------------------------------------------- settings */

async function save(key: SettingKey, value: unknown): Promise<void> {
  const reply = await api.set(key, value);
  if (reply === null) return;
  if (reply.ok) {
    messages.set(
      key,
      reply.saved
        ? { text: 'Saved.', kind: 'saved' }
        : { text: 'Applied, but the settings file could not be written.', kind: 'error' }
    );
  } else {
    messages.set(key, { text: reply.error, kind: 'error' });
  }
  apply(reply.state);
}

function idFor(key: SettingKey, part = ''): string {
  return `setting-${key}${part === '' ? '' : `-${part}`}`;
}

/** The control for one setting, wired to `save`. */
function controlFor(spec: SettingSpec, current: UserSettings, disabled: boolean): HTMLElement {
  const wrap = el('div', 'control');
  const key = spec.key;
  const value = current[key];
  const control = spec.control;

  switch (control.kind) {
    case 'toggle': {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.id = idFor(key);
      box.checked = value === true;
      box.disabled = disabled;
      box.addEventListener('change', () => void save(key, box.checked));
      wrap.append(box);
      break;
    }
    case 'choice': {
      const list = document.createElement('select');
      list.id = idFor(key);
      list.disabled = disabled;
      const options = control.dynamicOptions === 'palette' ? (state?.palettes ?? []) : control.options;
      for (const option of options) {
        const node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        node.selected = option.value === value;
        list.append(node);
      }
      list.addEventListener('change', () => void save(key, list.value));
      wrap.append(list);
      break;
    }
    case 'number': {
      const input = document.createElement('input');
      input.type = 'number';
      input.id = idFor(key);
      input.min = String(control.min);
      input.max = String(control.max);
      input.step = String(control.step);
      input.value = String(value);
      input.disabled = disabled;
      input.addEventListener('change', () => void save(key, Number(input.value)));
      wrap.append(input);
      if (control.unit !== '') wrap.append(el('span', undefined, control.unit));
      break;
    }
    case 'services': {
      const hidden = new Set(value as readonly string[]);
      const group = el('div', 'services');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-labelledby', idFor(key, 'name'));
      for (const service of SERVICES) {
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !hidden.has(service);
        box.disabled = disabled;
        box.addEventListener('change', () => {
          const next = SERVICES.filter((other) =>
            other === service ? !box.checked : hidden.has(other)
          );
          void save(key, next);
        });
        label.append(box, document.createTextNode(SERVICE_LABELS[service]));
        group.append(label);
      }
      wrap.append(group);
      break;
    }
    case 'shortcut': {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'shortcut';
      input.id = idFor(key);
      input.value = String(value);
      input.spellcheck = false;
      input.disabled = disabled;
      input.addEventListener('change', () => void save(key, input.value));
      wrap.append(input);
      break;
    }
    case 'creditPrice': {
      const price = value as UserSettings['codexCreditPrice'];
      const on = document.createElement('input');
      on.type = 'checkbox';
      on.id = idFor(key);
      on.checked = price !== null;
      on.disabled = disabled;
      on.setAttribute('aria-label', 'Show the estimate');
      const amount = document.createElement('input');
      amount.type = 'number';
      amount.min = '0';
      amount.step = '0.001';
      amount.value = String(price?.amount ?? 0.04);
      amount.disabled = disabled || price === null;
      amount.setAttribute('aria-label', 'Price per credit');
      const currency = document.createElement('input');
      currency.type = 'text';
      currency.className = 'currency';
      currency.maxLength = 3;
      currency.value = price?.currency ?? 'USD';
      currency.disabled = disabled || price === null;
      currency.setAttribute('aria-label', 'Currency code');
      const send = (): void =>
        void save(
          key,
          on.checked ? { amount: Number(amount.value), currency: currency.value.trim() } : null
        );
      on.addEventListener('change', send);
      amount.addEventListener('change', send);
      currency.addEventListener('change', send);
      wrap.append(on, amount, currency);
      break;
    }
  }
  return wrap;
}

function renderSettings(): void {
  const form = document.getElementById('settings');
  if (form === null || state === null) return;
  const current = state;
  // Keep focus on the same control across a re-render.
  const focused = document.activeElement?.id;
  form.replaceChildren();

  for (const group of SETTING_GROUPS) {
    const specs = SETTINGS.filter((spec) => spec.group === group.id);
    if (specs.length === 0) continue;
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = group.label;
    fieldset.append(legend);

    for (const spec of specs) {
      const lockReason = current.locked[spec.key];
      const row = el('div', 'setting');
      const usesLabel = spec.control.kind !== 'services';
      const name = document.createElement(usesLabel ? 'label' : 'span');
      name.id = idFor(spec.key, 'name');
      if (usesLabel) (name as HTMLLabelElement).htmlFor = idFor(spec.key);
      else name.className = 'name';
      name.textContent = spec.label;
      row.append(name, controlFor(spec, current.settings, lockReason !== undefined));

      const help = el('div', 'help', spec.help);
      help.id = idFor(spec.key, 'help');
      row.append(help);
      document.getElementById(idFor(spec.key))?.setAttribute('aria-describedby', help.id);

      const notes: string[] = [];
      if (lockReason !== undefined) notes.push(lockReason);
      if (spec.appliesOn === 'restart') notes.push('Takes effect after Walder restarts.');
      if (spec.key === 'hideShortcut') {
        const line = shortcutStatusLine(
          current.shortcutStatus,
          current.settings.hideShortcut,
          current.platform
        );
        if (line !== null) notes.push(line);
      }
      if (notes.length > 0) row.append(el('div', 'message', notes.join(' ')));

      const message = messages.get(spec.key);
      if (message !== undefined) {
        const node = el('div', `message ${message.kind}`, message.text);
        node.setAttribute('role', message.kind === 'error' ? 'alert' : 'status');
        row.append(node);
      }
      fieldset.append(row);
    }
    form.append(fieldset);
  }
  // `aria-describedby` needs the control in the document; set it now.
  for (const spec of SETTINGS) {
    document.getElementById(idFor(spec.key))?.setAttribute('aria-describedby', idFor(spec.key, 'help'));
  }
  if (focused !== undefined && focused !== '') document.getElementById(focused)?.focus();
}

/* ---------------------------------------------------------------- state */

function apply(next: SettingsWindowState): void {
  state = next;
  const version = document.getElementById('version');
  if (version !== null) version.textContent = `Version ${next.version}`;
  renderOverview();
  renderSettings();
}

async function boot(): Promise<void> {
  api.onChanged((next) => apply(next));
  const first = await api.get();
  if (first !== null) apply(first);
  // The card's "updated 3 min ago" lines age; redraw them once a minute.
  setInterval(renderOverview, 60_000);
}

void boot();
