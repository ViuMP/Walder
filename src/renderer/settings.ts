/**
 * The Walder window's renderer: a category rail on the left, one page on the
 * right.
 *
 *  - **Overview** stages Model, Colour and Card size against a preview (the
 *    coat's idle frame and the hover card, drawn by the card's own painter
 *    `card-dom.ts` at the staged size) and writes them only on **Apply**.
 *    Staged choices live here alone: pushes from main never reset them, and
 *    closing the window discards them. Refresh is the tray's Refresh.
 *  - **One page per settings group** draws one control per entry in
 *    `core/settings-spec` (Colour and Card size excepted: they are the
 *    Overview's) and saves each change as it is made, the way the tray does.
 *    Main validates again (the spec's own `validate`) and answers with the
 *    whole new state, which is what the page then shows, so a refused value
 *    snaps back and a change made in the tray menu while the window is open
 *    appears here too.
 */
import {
  CARD_SIZE_LABELS,
  SETTINGS,
  SETTING_GROUPS,
  type SettingKey,
  type SettingSpec,
  type UserSettings
} from '../core/settings-spec';
import { SERVICES } from '../core/services';
import { CARD_SIZES, SERVICE_LABELS, cardRowsFor, type CardSize } from '../core/card-layout';
import { shortcutStatusLine } from '../core/shortcuts';
import {
  CHARACTERS,
  characterOfCoat,
  coatForCharacter,
  coatsOf,
  effective,
  pendingChanges,
  type Character,
  type Staged
} from '../core/overview-stage';
import { rasteriseFrame } from '../sprites/raster';
import { FALLBACK_PALETTE } from '../sprites/contract';
import type { CoatPreview, SettingsWindowState } from '../main/settings-ipc';
import { el, paint } from './card-dom';

const api = window.walderSettings;
let state: SettingsWindowState | null = null;
/** Per-key message under the control: an error, or "Saved". */
const messages = new Map<SettingKey, { text: string; kind: 'error' | 'saved' | 'note' }>();

/* ----------------------------------------------------------------- rail */

/** The keys only the Overview edits, staged until Apply. */
const STAGED_KEYS: readonly SettingKey[] = ['palette', 'cardSize'];
const pages = ['overview', ...SETTING_GROUPS.map((group) => group.id)];
const rail = document.getElementById('rail');
const pageHost = document.getElementById('pages');

for (const group of SETTING_GROUPS) {
  const tab = el('button', 'tab', group.label);
  tab.id = `tab-${group.id}`;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-controls', `page-${group.id}`);
  rail?.append(tab);
  const page = el('section', 'page');
  page.id = `page-${group.id}`;
  page.setAttribute('role', 'tabpanel');
  page.setAttribute('aria-labelledby', tab.id);
  pageHost?.append(page);
}

function select(name: string): void {
  for (const page of pages) {
    const tab = document.getElementById(`tab-${page}`);
    const panel = document.getElementById(`page-${page}`);
    tab?.setAttribute('aria-selected', String(page === name));
    tab?.setAttribute('tabindex', page === name ? '0' : '-1');
    if (panel !== null) panel.hidden = page !== name;
  }
}
for (const page of pages) {
  document.getElementById(`tab-${page}`)?.addEventListener('click', () => select(page));
}
rail?.addEventListener('keydown', (event) => {
  const key = (event as KeyboardEvent).key;
  const current = pages.findIndex(
    (page) => document.getElementById(`tab-${page}`)?.getAttribute('aria-selected') === 'true'
  );
  let index: number;
  if (key === 'ArrowDown' || key === 'ArrowRight') index = (current + 1) % pages.length;
  else if (key === 'ArrowUp' || key === 'ArrowLeft') index = (current + pages.length - 1) % pages.length;
  else if (key === 'Home') index = 0;
  else if (key === 'End') index = pages.length - 1;
  else return;
  event.preventDefault();
  const next = pages[index] ?? 'overview';
  select(next);
  document.getElementById(`tab-${next}`)?.focus();
});
// Deep links for screenshots and the on-screen check: #<group id>, and the old
// #settings, which opens the first settings group.
{
  const hash = window.location.hash.slice(1);
  select(hash === 'settings' ? (SETTING_GROUPS[0]?.id ?? 'overview') : pages.includes(hash) ? hash : 'overview');
}

/* ------------------------------------------------------------- overview */

/** Every coat with its character and idle frame; asked for once at boot. */
let coats: CoatPreview[] = [];
let staged: Staged = {};
/** What the last Apply said; cleared by the next staged change. */
let stageStatus: { text: string; kind: 'error' | 'saved' } | null = null;

const modelSelect = document.getElementById('overview-model') as HTMLSelectElement | null;
const coatSelect = document.getElementById('setting-palette') as HTMLSelectElement | null;
const sizeSelect = document.getElementById('setting-cardSize') as HTMLSelectElement | null;
const applyButton = document.getElementById('apply') as HTMLButtonElement | null;
const revertButton = document.getElementById('revert') as HTMLButtonElement | null;
const sprite = document.getElementById('preview-sprite') as HTMLCanvasElement | null;

function saved(): { palette: string; cardSize: CardSize } {
  return { palette: state?.settings.palette ?? FALLBACK_PALETTE, cardSize: state?.settings.cardSize ?? 'large' };
}

/** The coats to offer: the previews, or (if main sent none) the bare palette list. */
function coatList(): readonly { id: string; label: string; character: Character }[] {
  if (coats.length > 0) return coats;
  return (state?.palettes ?? []).map((p) => ({ id: p.value, label: p.label, character: 'walder' as const }));
}

/** The staged coat, or golden when it is not one the sheet has (as the tray shows it). */
function shownCoat(): string {
  const palette = effective(staged, saved()).palette;
  return coatList().some((coat) => coat.id === palette) ? palette : FALLBACK_PALETTE;
}

function fillSelect(list: HTMLSelectElement, options: readonly { value: string; label: string }[], value: string): void {
  list.replaceChildren(
    ...options.map((option) => {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      node.selected = option.value === value;
      return node;
    })
  );
}

/** The staged controls and buttons. Redrawn on a stage change or a settings push, not on usage pushes. */
function renderStage(): void {
  if (state === null) return;
  const list = coatList();
  const coat = shownCoat();
  const character = characterOfCoat(coat, list);
  const characters = CHARACTERS.filter((c) => coatsOf(c.id, list).length > 0);
  const paletteLock = state.locked.palette;
  const sizeLock = state.locked.cardSize;
  if (modelSelect !== null) {
    fillSelect(modelSelect, characters.map((c) => ({ value: c.id, label: c.label })), character);
    modelSelect.disabled = paletteLock !== undefined || characters.length < 2;
  }
  if (coatSelect !== null) {
    fillSelect(coatSelect, coatsOf(character, list).map((c) => ({ value: c.id, label: c.label })), coat);
    coatSelect.disabled = paletteLock !== undefined;
  }
  if (sizeSelect !== null) {
    fillSelect(
      sizeSelect,
      CARD_SIZES.map((size) => ({ value: size, label: CARD_SIZE_LABELS[size] })),
      effective(staged, saved()).cardSize
    );
    sizeSelect.disabled = sizeLock !== undefined;
  }
  const pending = Object.keys(pendingChanges(staged, saved())).length > 0;
  if (applyButton !== null) applyButton.disabled = !pending;
  if (revertButton !== null) revertButton.disabled = !pending;

  const status = document.getElementById('apply-status');
  if (status !== null) {
    const locks = [paletteLock, sizeLock].filter((reason) => reason !== undefined);
    const line = stageStatus ?? (pending ? { text: 'Not applied yet.', kind: 'note' as const } : null);
    status.textContent = [line?.text, ...locks].filter((text) => text !== undefined).join(' ');
    status.className = `message ${line?.kind ?? ''}`;
  }
}

/** The preview: the staged coat's idle frame and the card at the staged size. */
function renderPreview(): void {
  if (state === null) return;
  const choice = effective(staged, saved());
  const preview = coats.find((coat) => coat.id === shownCoat());
  if (sprite !== null) {
    sprite.hidden = preview === undefined;
    const ctx = sprite.getContext('2d');
    if (preview !== undefined && ctx !== null) {
      const height = preview.rows.length;
      const width = preview.rows[0]?.length ?? 0;
      // Whole sprite pixels only: an integer scale, drawn unsmoothed.
      const scale = Math.max(1, Math.floor(160 / Math.max(width, height, 1)));
      sprite.width = width * scale;
      sprite.height = height * scale;
      ctx.clearRect(0, 0, sprite.width, sprite.height);
      rasteriseFrame({ box: '', rows: preview.rows }, preview.colors, scale, ctx);
      sprite.setAttribute('aria-label', `${preview.label}, as Walder draws it`);
    }
  }
  const card = document.getElementById('card');
  if (card === null) return;
  paint(
    card,
    cardRowsFor(
      state.usage,
      choice.cardSize,
      Date.now(),
      navigator.language,
      state.creditPrice,
      state.settings.resetStyle,
      state.sessions
    )
  );
  // The card itself says nothing when no service has answered yet; here,
  // where someone is looking on purpose, say what to do about it.
  if (card.querySelector('.section') === null) {
    card.append(
      el(
        'div',
        'note',
        'No usage yet. Log in from the tray menu under Accounts, or sign in to Claude Code, Codex, Cursor or the GitHub CLI on this computer.'
      )
    );
  }
}

function stage(next: Staged): void {
  staged = next;
  stageStatus = null;
  renderStage();
  renderPreview();
}

modelSelect?.addEventListener('change', () => {
  const coat = coatForCharacter(modelSelect.value as Character, shownCoat(), coatList());
  if (coat !== null) stage({ ...staged, palette: coat });
});
coatSelect?.addEventListener('change', () => stage({ ...staged, palette: coatSelect.value }));
sizeSelect?.addEventListener('change', () => stage({ ...staged, cardSize: sizeSelect.value as CardSize }));
revertButton?.addEventListener('click', () => stage({}));

const STAGED_LABELS: Record<string, string> = { palette: 'Colour', cardSize: 'Card size' };
applyButton?.addEventListener('click', () => {
  void (async () => {
    const changes = Object.entries(pendingChanges(staged, saved()));
    const errors: string[] = [];
    let latest: SettingsWindowState | null = null;
    const left: Staged = { ...staged };
    for (const [key, value] of changes) {
      const reply = await api.set(key, value);
      const label = STAGED_LABELS[key] ?? key;
      if (reply === null) {
        errors.push(`${label}: not applied.`);
        continue;
      }
      latest = reply.state;
      if (!reply.ok) {
        errors.push(`${label}: ${reply.error}`);
        continue;
      }
      delete left[key as keyof Staged];
      if (!reply.saved) errors.push(`${label}: applied, but the settings file could not be written.`);
    }
    staged = left;
    stageStatus = errors.length > 0 ? { text: errors.join(' '), kind: 'error' } : { text: 'Applied.', kind: 'saved' };
    if (latest !== null) apply(latest, true);
    else {
      renderStage();
      renderPreview();
    }
  })();
});

const refreshButton = document.getElementById('refresh') as HTMLButtonElement | null;
const refreshStatus = document.getElementById('refresh-status');
refreshButton?.addEventListener('click', () => {
  void api.refresh().then((waiting) => {
    if (refreshStatus === null) return;
    const names = (waiting ?? []).map(
      (service) => SERVICE_LABELS[service as keyof typeof SERVICE_LABELS] ?? service
    );
    refreshStatus.textContent =
      names.length === 0
        ? 'Checking every service now.'
        : `Checking now. ${names.join(' and ')} asked Walder to wait, so it is checked when that wait ends.`;
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
  // Forced: a refused value must snap back even though the state is unchanged.
  apply(reply.state, true);
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
  if (state === null) return;
  const current = state;
  // Keep focus on the same control across a re-render.
  const focused = document.activeElement?.id;

  for (const group of SETTING_GROUPS) {
    const page = document.getElementById(`page-${group.id}`);
    if (page === null) continue;
    page.replaceChildren();
    const specs = SETTINGS.filter((spec) => spec.group === group.id && !STAGED_KEYS.includes(spec.key));
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
    page.append(fieldset);
  }
  // `aria-describedby` needs the control in the document; set it now.
  for (const spec of SETTINGS) {
    if (STAGED_KEYS.includes(spec.key)) continue;
    document.getElementById(idFor(spec.key))?.setAttribute('aria-describedby', idFor(spec.key, 'help'));
  }
  if (focused !== undefined && focused !== '') document.getElementById(focused)?.focus();
}

/* ---------------------------------------------------------------- state */

/** The parts of the state the settings pages and staged controls draw. Usage pushes do not touch them. */
function settingsKey(s: SettingsWindowState): string {
  return JSON.stringify([s.settings, s.locked, s.palettes, s.shortcutStatus]);
}
let drawnSettings = '';

function apply(next: SettingsWindowState, force = false): void {
  state = next;
  const version = document.getElementById('version');
  if (version !== null) version.textContent = `Version ${next.version}`;
  renderPreview();
  // Main pushes on every usage publish and hook event. Rebuilding the form then
  // would wipe a half-typed value or close an open list, so the form is redrawn
  // only when something it shows has changed, or when a save answered.
  const key = settingsKey(next);
  if (force || key !== drawnSettings) {
    drawnSettings = key;
    renderSettings();
    renderStage();
  }
}

async function boot(): Promise<void> {
  api.onChanged((next) => apply(next));
  coats = (await api.previews()) ?? [];
  const first = await api.get();
  // Forced: a push that came while the previews loaded drew the coats without them.
  if (first !== null) apply(first, true);
  // The card's "updated 3 min ago" lines age; redraw them once a minute.
  setInterval(renderPreview, 60_000);
}

void boot();
