/**
 * Safe structural diagnostics for a raw usage response.
 *
 * This lives in `core` because providers need the pure formatter while
 * `main/` must remain the owner of Electron logging. It describes only known
 * parser containers, prints numbers and booleans when useful for diagnosis,
 * and never prints a string value from an account payload.
 */

const SHAPE_DETAIL_KEYS: ReadonlySet<string> = new Set([
  'limits',
  'seven_day_breakdown',
  'extra_usage',
  'spend',
  'seven_day_omelette',
  'seven_day_cowork',
  'seven_day_opus',
  'seven_day_sonnet',
  'five_hour',
  'seven_day',
  // chatgpt.com `/backend-api/wham/usage`: the Codex credit and spend blocks.
  'credits',
  'spend_control',
  'rate_limit_reset_credits',
  // api2.cursor.sh `GetCurrentPeriodUsage`: the percentages and the spend cap.
  'planUsage',
  'spendLimitUsage'
]);

/** Enough depth for the confirmed payload without permitting an unbounded walk. */
const MAX_SHAPE_DEPTH = 6;

function spaceKey(key: string): string {
  return key.replace(/_+/g, ' ').trim();
}

function shapeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/*
 * The few string fields whose *content* the dump may print: amounts and units
 * of a spend limit, which are numbers-as-strings and a unit name. Nothing that
 * identifies the account, a plan or a person — those stay as lengths.
 */
const PLAIN_STRING_KEYS: ReadonlySet<string> = new Set(['unit', 'limit', 'used']);

function shapeValue(value: unknown, key?: string): string {
  if (typeof value === 'string') {
    return key !== undefined && PLAIN_STRING_KEYS.has(key)
      ? `"${value}"`
      : `<string:${value.length} chars>`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return shapeType(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walkShape(path: string, value: unknown, depth: number, out: string[]): void {
  if (depth > MAX_SHAPE_DEPTH) return;

  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      const elementPath = `${path} [${index}]`;
      if (isRecord(element) || Array.isArray(element)) {
        out.push(`${elementPath}: ${shapeType(element)}`);
        walkShape(elementPath, element, depth + 1, out);
      } else {
        out.push(`${elementPath} = ${shapeValue(element)}`);
      }
    });
    return;
  }

  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = `${path} . ${spaceKey(key)}`;
    if (isRecord(nested) || Array.isArray(nested)) {
      out.push(`${nestedPath}: ${shapeType(nested)}`);
      walkShape(nestedPath, nested, depth + 1, out);
    } else {
      out.push(`${nestedPath} = ${shapeValue(nested, key)}`);
    }
  }
}

/**
 * Describe a raw usage payload's structure for a developer running with
 * `WALDER_DUMP_USAGE_SHAPE=1`. The caller owns the environment/build/logging
 * gates; this function has no I/O and returns no string values from the input.
 */
export function usageShapeLines(json: unknown): string[] {
  if (!isRecord(json)) return [`(payload is ${shapeType(json)}, not an object)`];

  const out: string[] = [];
  for (const [key, value] of Object.entries(json)) {
    const name = spaceKey(key);
    out.push(`${name}: ${shapeType(value)}`);
    if (!SHAPE_DETAIL_KEYS.has(key)) continue;
    if (isRecord(value) || Array.isArray(value)) walkShape(name, value, 1, out);
  }
  return out;
}

/* ------------------------------------------------------------ key tree */

/** Enough depth for a dashboard payload; a deeper walk is not a shape any more. */
const MAX_TREE_DEPTH = 4;

/**
 * `camelCase` and `snake_case` to spaced words, so a long key name does not
 * look like a token to the log redactor (which hides any 20+ character run of
 * base64-ish characters — the right rule for a value, and the reason
 * `individualUsageBasedSomething` came out as `[redacted]` in a probe run).
 */
function spacedName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_+/g, ' ')
    .trim();
}

/**
 * The key names and value *types* of a payload, nested, and nothing else.
 *
 * For `npm run probe -- --keys` on a provider whose parser does not exist yet:
 * the top-level keys alone said nothing about where Cursor keeps its
 * percentages. Unlike `usageShapeLines`, this prints no number, no boolean and
 * no string length — a type per key is the whole of it, so the output keeps
 * the `--keys` promise ("key names only, no usage numbers") to the letter.
 * Arrays describe their first element, since a usage array is homogeneous and
 * the count is a value.
 */
export function keyTreeLines(json: unknown, depth = 0, out: string[] = []): string[] {
  if (depth === 0 && !isRecord(json)) return [`(payload is ${shapeType(json)}, not an object)`];
  if (depth > MAX_TREE_DEPTH || !isRecord(json)) return out;
  const indent = '  '.repeat(depth);
  for (const [key, value] of Object.entries(json)) {
    if (Array.isArray(value)) {
      const first: unknown = value[0];
      out.push(`${indent}${spacedName(key)}: array of ${first === undefined ? 'nothing' : shapeType(first)}`);
      if (isRecord(first)) keyTreeLines(first, depth + 1, out);
    } else {
      out.push(`${indent}${spacedName(key)}: ${shapeType(value)}`);
      if (isRecord(value)) keyTreeLines(value, depth + 1, out);
    }
  }
  return out;
}
