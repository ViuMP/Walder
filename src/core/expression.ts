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

/**
 * Which animation to play for a box and an expression, given what the sheet
 * actually has.
 *
 * The lookup is a *cascade*, not a table, because the art and the code advance
 * separately: the winning mascot design may ship five per-expression idle loops,
 * or one, or none, and Walder must look right either way rather than going blank
 * when a name is missing.
 *
 *   sleep box            -> `sleep`
 *   `idle_<expression>`  -> the per-expression idle loop, when the art has one
 *   `out` / `confused`   -> those two get their own whole-body animations if
 *                          present: they are states ("no allowance left", "no
 *                          idea"), not just faces
 *   `idle`               -> always present (the sheet contract guarantees it)
 *
 * Pure, and takes a predicate rather than a sheet, so it is unit-tested without
 * building a sheet and can be called from either process.
 */
export function pickAnimation(
  box: string,
  expression: Expression,
  has: (name: string) => boolean
): string {
  if (box === 'sleep' && has('sleep')) return 'sleep';

  const perExpression = `idle_${expression}`;
  if (has(perExpression)) return perExpression;

  if ((expression === 'out' || expression === 'confused') && has(expression)) return expression;

  return 'idle';
}
