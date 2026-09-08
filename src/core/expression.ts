/**
 * Maps the Claude 5-hour usage percentage onto Walder's face.
 */

export type Expression = 'happy' | 'neutral' | 'worried' | 'exhausted' | 'out' | 'confused';

/**
 * `null` (or a non-finite number) means "we do not know the usage" and shows
 * the confused face rather than a falsely cheerful one.
 */
export function expressionFor(fiveHourPct: number | null): Expression {
  if (fiveHourPct === null || !Number.isFinite(fiveHourPct)) return 'confused';
  if (fiveHourPct < 50) return 'happy';
  if (fiveHourPct < 80) return 'neutral';
  if (fiveHourPct < 95) return 'worried';
  if (fiveHourPct < 100) return 'exhausted';
  return 'out';
}
