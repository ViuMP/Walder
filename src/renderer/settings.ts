/**
 * The Walder window's renderer: a category rail on the left, one page on the
 * right.
 *
 *  - **Overview** stages Model, Coat and Card size against a preview (the
 *    coat's idle frame and the hover card, drawn by the card's own painter
 *    `card-dom.ts` at the staged size) and writes them only on **Apply**.
 *    Staged choices live here alone: pushes from main never reset them, and
 *    closing the window discards them. Refresh is the tray's Refresh. The
 *    visible pickers are radio groups; the hidden native lists behind them
 *    (`#overview-model`, `#setting-palette`, `#setting-cardSize`) stay the
 *    one place a choice is staged from, so a script can still drive them.
 *  - The **rail** shows the saved coat, the pages, and whether any shown
 *    service answered. The `theme` setting sets `data-theme` on <html>.
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
  SIZE_LABELS,
  SIZE_NAMES,
  type SizeName,
  SETTINGS,
  SETTING_GROUPS,
  type SettingKey,
  type SettingSpec,
  type UserSettings
} from '../core/settings-spec';
import { SERVICES, type ServiceName } from '../core/services';
import { CARD_SIZES, SERVICE_LABELS, cardRowsFor, type CardSize } from '../core/card-layout';
import { shortcutStatusLine } from '../core/shortcuts';
import {
  CHARACTERS,
  anyConnected,
  characterOfCoat,
  coatForCharacter,
  coatShortLabel,
  coatsOf,
  effective,
  pendingChanges,
  serviceStatusWord,
  swatchColor,
  type Character,
  type Staged
} from '../core/overview-stage';
import { rasteriseFrame } from '../sprites/raster';
import { TRANSPARENT } from '../sprites/types';
import { PANEL_GAP, placePanel } from '../core/panel-place';
import { FALLBACK_PALETTE } from '../sprites/contract';
import type { CoatPreview, SettingsWindowState } from '../main/settings-ipc';
import { el, paint } from './card-dom';

const api = window.walderSettings;
let state: SettingsWindowState | null = null;
/** Per-key message under the control: an error, or "Saved". */
const messages = new Map<SettingKey, { text: string; kind: 'error' | 'saved' | 'note' }>();

/* ----------------------------------------------------------------- rail */

/** The keys only the Overview edits, staged until Apply. */
const STAGED_KEYS: readonly SettingKey[] = ['palette', 'size', 'cardSize'];
const pages = ['overview', ...SETTING_GROUPS.map((group) => group.id)];
const rail = document.getElementById('rail');
const pageHost = document.getElementById('pages');

/** Line icons for the rail, drawn here (no icon library): 24-unit paths, stroked in the text colour. */
const ICONS: Record<string, string[]> = {
  overview: ['M3 11 12 4l9 7', 'M5 10v10h5v-6h4v6h5V10'],
  appearance: ['M3 4h18v12H3z', 'M8 20h8', 'M12 16v4'],
  alerts: ['M6 16V11a6 6 0 0 1 12 0v5l2 2H4z', 'M10 21h4'],
  visibility: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  usage: ['M5 20v-5', 'M10 20v-9', 'M15 20V7', 'M20 20V4'],
  app: [
    'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
    'M10.5 3h3l.5 2.5 2 .9 2.2-1.4 2.1 2.1-1.4 2.2.9 2 2.5.5v3l-2.5.5-.9 2 1.4 2.2-2.1 2.1-2.2-1.4-2 .9-.5 2.5h-3l-.5-2.5-2-.9-2.2 1.4-2.1-2.1 1.4-2.2-.9-2L3 13.5v-3l2.5-.5.9-2L5 5.8 7.1 3.7 9.3 5.1l2-.9z'
  ],
  advanced: ['M4 6h16', 'M4 12h16', 'M4 18h16', 'M9 4v4', 'M15 10v4', 'M7 16v4']
};

function icon(name: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name] ?? []) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

document.getElementById('tab-overview')?.prepend(icon('overview'));
for (const group of SETTING_GROUPS) {
  const tab = el('button', 'tab', group.label);
  tab.prepend(icon(group.id));
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
const dogSizeSelect = document.getElementById('setting-size') as HTMLSelectElement | null;
const dogSizeSegments = document.getElementById('dog-size-segments');
/** The preview draws the companion at the desktop's own scale for each size. */
const SPRITE_SCALE: Readonly<Record<SizeName, number>> = { small: 1, medium: 2, large: 3 };
const applyButton = document.getElementById('apply') as HTMLButtonElement | null;
const revertButton = document.getElementById('revert') as HTMLButtonElement | null;
const sprite = document.getElementById('preview-sprite') as HTMLCanvasElement | null;
const railSprite = document.getElementById('rail-sprite') as HTMLCanvasElement | null;
const modelCards = document.getElementById('model-cards');
const coatSwatches = document.getElementById('coat-swatches');
const sizeSegments = document.getElementById('size-segments');

/** A coat's idle frame, whole, at an integer scale (drawn unsmoothed by CSS). */
function drawCoat(canvas: HTMLCanvasElement, preview: CoatPreview, scale: number): void {
  const ctx = canvas.getContext('2d');
  canvas.width = (preview.rows[0]?.length ?? 0) * scale;
  canvas.height = preview.rows.length * scale;
  if (ctx === null) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  rasteriseFrame({ box: '', rows: preview.rows }, preview.colors, scale, ctx);
}

/**
 * One radio group of buttons. Arrow keys pick the next one (wired once, in
 * `radioKeys`); a pick goes through `pick`, and when the group is redrawn
 * while it holds focus, focus moves to the checked button.
 */
function radioGroup(
  host: HTMLElement | null,
  items: readonly { value: string; fill: (button: HTMLButtonElement) => void }[],
  current: string,
  disabled: boolean,
  pick: (value: string) => void
): void {
  if (host === null) return;
  const hadFocus = host.contains(document.activeElement);
  const buttons = items.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(item.value === current));
    button.tabIndex = item.value === current ? 0 : -1;
    button.disabled = disabled;
    item.fill(button);
    button.addEventListener('click', () => {
      if (item.value !== current) pick(item.value);
    });
    return button;
  });
  if (!buttons.some((button) => button.tabIndex === 0) && buttons[0] !== undefined) buttons[0].tabIndex = 0;
  host.replaceChildren(...buttons);
  if (hadFocus) host.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
}

function radioKeys(host: HTMLElement | null): void {
  host?.addEventListener('keydown', (event) => {
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const current = buttons.findIndex((button) => button === document.activeElement);
    if (current < 0) return;
    let index: number;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') index = (current + 1) % buttons.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') index = (current + buttons.length - 1) % buttons.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[index]?.click();
  });
}
radioKeys(modelCards);
radioKeys(coatSwatches);
radioKeys(sizeSegments);
radioKeys(dogSizeSegments);

/** Stage through the hidden native list, the one path a choice takes (and the one a script drives). */
function pickVia(list: HTMLSelectElement | null): (value: string) => void {
  return (value) => {
    if (list === null) return;
    list.value = value;
    list.dispatchEvent(new Event('change'));
  };
}

function saved(): { palette: string; size: SizeName; cardSize: CardSize } {
  return {
    palette: state?.settings.palette ?? FALLBACK_PALETTE,
    size: state?.settings.size ?? 'medium',
    cardSize: state?.settings.cardSize ?? 'large'
  };
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
  const size = effective(staged, saved()).cardSize;
  const dogSize = effective(staged, saved()).size;
  const dogSizeLock = state.locked.size;
  if (dogSizeSelect !== null) {
    fillSelect(dogSizeSelect, SIZE_NAMES.map((s) => ({ value: s, label: SIZE_LABELS[s] })), dogSize);
    dogSizeSelect.disabled = dogSizeLock !== undefined;
  }
  radioGroup(
    dogSizeSegments,
    SIZE_NAMES.map((s) => ({
      value: s,
      fill: (button) => {
        button.className = 'segment';
        button.textContent = SIZE_LABELS[s];
      }
    })),
    dogSize,
    dogSizeLock !== undefined,
    pickVia(dogSizeSelect)
  );

  radioGroup(
    modelCards,
    characters.map((c) => ({
      value: c.id,
      fill: (button) => {
        button.className = 'model';
        button.setAttribute('aria-label', c.label);
        const own = coatsOf(c.id, coats);
        const shown = own.find((p) => p.id === coat) ?? own[0];
        if (shown !== undefined) {
          const canvas = document.createElement('canvas');
          canvas.setAttribute('aria-hidden', 'true');
          drawCoat(canvas, shown, 1);
          button.append(canvas);
        }
        button.append(el('span', undefined, c.label.split(' ')[0] ?? c.label));
      }
    })),
    character,
    paletteLock !== undefined || characters.length < 2,
    pickVia(modelSelect)
  );
  radioGroup(
    coatSwatches,
    coatsOf(character, list).map((c) => ({
      value: c.id,
      fill: (button) => {
        button.className = 'swatch';
        const chip = el('span', 'chip');
        chip.setAttribute('aria-hidden', 'true');
        const preview = coats.find((p) => p.id === c.id);
        if (preview !== undefined) chip.style.backgroundColor = swatchColor(preview.rows, preview.colors);
        button.append(chip, el('span', undefined, coatShortLabel(c.label, c.character)));
      }
    })),
    coat,
    paletteLock !== undefined,
    pickVia(coatSelect)
  );
  radioGroup(
    sizeSegments,
    (['small', 'medium', 'large'] as const)
      .filter((s) => CARD_SIZES.includes(s))
      .map((s) => ({
        value: s,
        fill: (button) => {
          button.className = 'segment';
          button.textContent = CARD_SIZE_LABELS[s];
        }
      })),
    size,
    sizeLock !== undefined,
    pickVia(sizeSelect)
  );

  // The rail shows the saved coat, not the staged one.
  const savedCoat = coats.find((p) => p.id === state?.settings.palette) ?? coats.find((p) => p.id === FALLBACK_PALETTE);
  if (railSprite !== null) {
    railSprite.hidden = savedCoat === undefined;
    if (savedCoat !== undefined) drawCoat(railSprite, savedCoat, 2);
  }

  const pending = Object.keys(pendingChanges(staged, saved())).length > 0;
  const pill = document.getElementById('unapplied');
  if (pill !== null) pill.hidden = !pending;
  if (applyButton !== null) applyButton.disabled = !pending;
  if (revertButton !== null) revertButton.disabled = !pending;

  const status = document.getElementById('apply-status');
  if (status !== null) {
    const locks = [paletteLock, dogSizeLock, sizeLock].filter((reason) => reason !== undefined);
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
    if (preview !== undefined) {
      // Whole sprite pixels only: an integer scale, drawn unsmoothed.
      drawCoat(sprite, preview, SPRITE_SCALE[choice.size]);
      sprite.setAttribute('aria-label', `${preview.label}, as Walder draws it`);
    }
  }
  const card = document.getElementById('card');
  if (card === null) return;
  // Laid out after the paint below; until then keep it where it was.
  queueMicrotask(placeCard);
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

/** The drawn pixels of a frame, in sprite pixels: what the desktop measures the card from. */
function inkBox(rows: readonly string[]): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === TRANSPARENT) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  });
  if (maxX < 0) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Put the card where the desktop would: beside the companion's ink, on its
 * left, top-aligned with it and pulled up to fit, inside the stage (below the
 * Preview tag) as the work area.
 */
function placeCard(): void {
  const card = document.getElementById('card');
  const stageBox = document.querySelector('.stage');
  const preview = coats.find((coat) => coat.id === shownCoat());
  if (card === null || !(stageBox instanceof HTMLElement) || sprite === null || preview === undefined) return;
  const scale = SPRITE_SCALE[effective(staged, saved()).size];
  const ink = inkBox(preview.rows);
  const dog = {
    x: sprite.offsetLeft + ink.x * scale,
    y: sprite.offsetTop + ink.y * scale,
    width: ink.width * scale,
    height: ink.height * scale
  };
  const TOP = 52; // clear of the Preview tag and the Unapplied changes pill
  const INSET = 16;
  const area = {
    x: INSET,
    y: TOP,
    width: stageBox.clientWidth - 2 * INSET,
    height: stageBox.clientHeight - TOP - INSET
  };
  // The desktop has room on the dog's left; the stage may not (a Large dog
  // with a Large card), so the card narrows there rather than flip over him.
  card.style.maxWidth = `${Math.max(0, dog.x - PANEL_GAP - INSET)}px`;
  const at = placePanel(dog, { width: card.offsetWidth, height: card.offsetHeight }, area);
  card.style.left = `${at.x}px`;
  card.style.top = `${at.y}px`;
}
window.addEventListener('resize', placeCard);

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
dogSizeSelect?.addEventListener('change', () => stage({ ...staged, size: dogSizeSelect.value as SizeName }));
revertButton?.addEventListener('click', () => stage({}));

const STAGED_LABELS: Record<string, string> = { palette: 'Coat', size: 'Size', cardSize: 'Card size' };
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

/** The services bar and the rail's connection line: redrawn on every push, usage included. */
function renderServices(): void {
  if (state === null) return;
  const hidden = new Set<string>(state.settings.hiddenServices);
  const shown = SERVICES.filter((service: ServiceName) => !hidden.has(service));
  const usage = state.usage;
  const listHost = document.getElementById('service-list');
  listHost?.replaceChildren(
    ...shown.map((service) => {
      const status = usage?.services[service]?.status;
      const item = el('li');
      const line = el('span', 'service-state');
      const tone = status === 'ok' ? 'ok' : status === 'auth-needed' || status === 'rate-limited' ? 'warn' : '';
      const dot = el('span', `dot ${tone}`);
      dot.setAttribute('aria-hidden', 'true');
      line.append(dot, el('span', undefined, status === undefined ? 'Not checked yet' : serviceStatusWord(status)));
      item.append(el('span', 'service-name', SERVICE_LABELS[service]), line);
      return item;
    })
  );
  const connected = usage !== null && anyConnected(shown.map((service) => usage.services[service].status));
  const dot = document.getElementById('connection-dot');
  if (dot !== null) dot.className = `dot ${connected ? 'ok' : ''}`;
  const text = document.getElementById('connection-text');
  if (text !== null) text.textContent = connected ? 'Connected' : 'Not connected';
}

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
  // `auto` is left to the stylesheet's prefers-color-scheme, which follows the system live.
  document.documentElement.dataset['theme'] = next.settings.theme;
  renderPreview();
  renderServices();
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
