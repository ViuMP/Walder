/**
 * The Walder window's Overview: choices that are staged, not saved.
 *
 * Model, Colour and Card size are picked there against a preview and only
 * reach the settings writer on **Apply**. The staged values are overrides on
 * top of the saved settings, so a push from main (every usage publish, a tray
 * change) never resets them, and a staged value that equals the saved one is
 * simply not a change. Pure, so the node tests can pin it.
 */
import type { CardSize } from './card-layout';

/** Which character a coat belongs to. `characterOf` in `sprites/contract.ts` decides. */
export type Character = 'walder' | 'yuna';
export const CHARACTERS: readonly { id: Character; label: string }[] = [
  { id: 'walder', label: 'Walder the dog' },
  { id: 'yuna', label: 'Yuna the cat' }
];

/** What the Overview can stage. Absent means "as saved". */
export interface Staged {
  palette?: string;
  cardSize?: CardSize;
}

export interface Saved {
  palette: string;
  cardSize: CardSize;
}

/** The value each staged key would have after Apply. */
export function effective(staged: Staged, saved: Saved): Saved {
  return { palette: staged.palette ?? saved.palette, cardSize: staged.cardSize ?? saved.cardSize };
}

/** The keys Apply has to write: staged and different from what is saved. */
export function pendingChanges(staged: Staged, saved: Saved): Partial<Saved> {
  const changes: Partial<Saved> = {};
  if (staged.palette !== undefined && staged.palette !== saved.palette) changes.palette = staged.palette;
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
