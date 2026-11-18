/**
 * The Walder window's Overview: choices that are staged, not saved.
 *
 * Model, Colour, Size and Card size are picked there against a preview and only
 * reach the settings writer on **Apply**. The staged values are overrides on
 * top of the saved settings, so a push from main (every usage publish, a tray
 * change) never resets them, and a staged value that equals the saved one is
 * simply not a change. Pure, so the node tests can pin it.
 */
import type { CardSize } from './card-layout';
import type { SizeName } from './settings-spec';
import type { SourceStatus } from './buckets';
import { t } from './strings';

/** Which character a coat belongs to. `characterOf` in `sprites/contract.ts` decides. */
export type Character = 'walder' | 'yuna';
export const CHARACTERS: readonly { id: Character; label: string }[] = [
  { id: 'walder', label: 'Walder the dog' },
  { id: 'yuna', label: 'Yuna the cat' }
];

/** What the Overview can stage. Absent means "as saved". */
export interface Staged {
  palette?: string;
  size?: SizeName;
  cardSize?: CardSize;
}

export interface Saved {
  palette: string;
  size: SizeName;
  cardSize: CardSize;
}

/** The value each staged key would have after Apply. */
export function effective(staged: Staged, saved: Saved): Saved {
  return {
    palette: staged.palette ?? saved.palette,
    size: staged.size ?? saved.size,
    cardSize: staged.cardSize ?? saved.cardSize
  };
}

/** The keys Apply has to write: staged and different from what is saved. */
export function pendingChanges(staged: Staged, saved: Saved): Partial<Saved> {
  const changes: Partial<Saved> = {};
  if (staged.palette !== undefined && staged.palette !== saved.palette) changes.palette = staged.palette;
  if (staged.size !== undefined && staged.size !== saved.size) changes.size = staged.size;
  if (staged.cardSize !== undefined && staged.cardSize !== saved.cardSize) changes.cardSize = staged.cardSize;
  return changes;
}

export interface CoatInfo {
  readonly id: string;
  readonly character: Character;
}

/** The coats of one character, in sheet order. */
export function coatsOf<T extends CoatInfo>(character: Character, coats: readonly T[]): T[] {
  return coats.filter((coat) => coat.character === character);
}

/** The character a coat id belongs to; an unknown coat draws as Walder (the golden fallback). */
export function characterOfCoat(id: string, coats: readonly CoatInfo[]): Character {
  return coats.find((coat) => coat.id === id)?.character ?? 'walder';
}

/**
 * The coat to stage when the model changes: the current one if it belongs to
 * that character, else the character's first coat (`null` if it has none).
 */
export function coatForCharacter(
  character: Character,
  current: string,
  coats: readonly CoatInfo[]
): string | null {
  const own = coatsOf(character, coats);
  if (own.some((coat) => coat.id === current)) return current;
  return own[0]?.id ?? null;
}

/** The palette letters that are coat (`art/README.md`): not `q`, the outline, nor the shared eyes, nose and tongue. */
const COAT_LETTERS = ['a', 'h', 'l', 'm', 't', 'd', 'o'] as const;

/**
 * The swatch colour for a coat: the coat letter painted most in its idle
 * frame. For the dogs that is `m`, "coat mid — the dominant tone"; for silver
 * dapple, the black cat and the tuxedo it is the tone that actually covers
 * most of the body, which a fixed letter would miss. A tie goes to the
 * earlier letter; a frame with no coat pixels falls back to `m`.
 */
export function swatchColor(rows: readonly string[], colors: Readonly<Record<string, string>>): string {
  const counts = new Map<string, number>();
  for (const row of rows) for (const letter of row) counts.set(letter, (counts.get(letter) ?? 0) + 1);
  let best = 'm';
  let most = 0;
  for (const letter of COAT_LETTERS) {
    const count = counts.get(letter) ?? 0;
    if (count > most) [best, most] = [letter, count];
  }
  return colors[best] ?? '#8d8880';
}

/** "Yuna calico" -> "Calico": the coat's name without its character's. */
export function coatShortLabel(label: string, character: Character): string {
  const prefix = `${character} `;
  if (!label.toLowerCase().startsWith(prefix)) return label;
  const rest = label.slice(prefix.length);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** One word for a service's state in the window's services bar. */
export function serviceStatusWord(status: SourceStatus): string {
  switch (status) {
    case 'ok':
      return t('serviceStatus.ok');
    case 'auth-needed':
      return t('serviceStatus.authNeeded');
    case 'rate-limited':
      return t('serviceStatus.waiting');
    case 'endpoint-changed':
    case 'error':
      return t('serviceStatus.error');
    case 'unavailable':
    default:
      return t('serviceStatus.notSetUp');
  }
}

/** True when at least one shown service answered: what the rail's CONNECTED line says. */
export function anyConnected(statuses: readonly SourceStatus[]): boolean {
  return statuses.includes('ok');
}
