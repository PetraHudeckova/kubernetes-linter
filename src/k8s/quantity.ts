/**
 * Parsing for k8s.io/apimachinery/pkg/api/resource.Quantity.
 *
 * Valid forms are <signedNumber><suffix> where suffix is a decimal SI unit
 * (n, u, m, "", k, M, G, T, P, E), a binary SI unit (Ki, Mi, Gi, Ti, Pi, Ei),
 * or a decimal exponent (e3, E-6).
 */

const DECIMAL_SI: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

const BINARY_SI: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

const QUANTITY = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+))((?:[KMGTPE]i)|[numkMGTPE]|(?:[eE][-+]?\d+))?$/;

export interface Quantity {
  ok: boolean;
  /** Numeric value in base units, present when ok. */
  value?: number;
  suffix?: string;
  reason?: string;
  /** A corrected spelling when the input looks like a common mistake. */
  suggestion?: string;
}

export function parseQuantity(input: unknown): Quantity {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, reason: 'must be a finite number' };
    return { ok: true, value: input, suffix: '' };
  }
  if (typeof input !== 'string') {
    return { ok: false, reason: 'must be a string such as "128Mi" or "500m"' };
  }

  const raw = input.trim();
  if (raw.length === 0) return { ok: false, reason: 'must not be empty' };

  const match = QUANTITY.exec(raw);
  if (!match) {
    return {
      ok: false,
      reason: 'is not a valid quantity (expected a number with an optional suffix such as "Mi", "G" or "m")',
      suggestion: suggestQuantity(raw),
    };
  }

  const [, numberPart, suffix = ''] = match;
  const base = Number(numberPart);
  if (!Number.isFinite(base)) return { ok: false, reason: 'is not a valid number' };

  if (suffix.startsWith('e') || suffix.startsWith('E')) {
    if (suffix.length > 1) {
      return { ok: true, value: Number(`${numberPart}${suffix}`), suffix };
    }
  }
  const multiplier = BINARY_SI[suffix] ?? DECIMAL_SI[suffix];
  if (multiplier === undefined) {
    return { ok: false, reason: `has an unknown suffix "${suffix}"`, suggestion: suggestQuantity(raw) };
  }
  return { ok: true, value: base * multiplier, suffix };
}

/**
 * Map common mis-spellings onto valid quantities. "128mb" and "1GB" are the
 * usual ones: Kubernetes has no byte suffix, and units are case-sensitive.
 */
export function suggestQuantity(raw: string): string | undefined {
  const match = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*([A-Za-z]+)$/.exec(raw.trim());
  if (!match) return undefined;
  const [, numberPart, rawSuffix] = match;
  if (!numberPart || !rawSuffix) return undefined;

  // Drop a trailing "b"/"B" ("mb", "GB", "Gib") and normalise case.
  const stripped = rawSuffix.replace(/[bB]$/, '');
  const normalised = stripped.toLowerCase();

  const binary: Record<string, string> = {
    ki: 'Ki',
    mi: 'Mi',
    gi: 'Gi',
    ti: 'Ti',
    pi: 'Pi',
    ei: 'Ei',
  };
  if (binary[normalised]) return `${numberPart}${binary[normalised]}`;

  // A bare unit that came with a "b" almost certainly meant bytes, so map it to
  // the binary suffix people expect ("128mb" -> "128Mi").
  const hadByteSuffix = /[bB]$/.test(rawSuffix);
  const single: Record<string, { binary: string; decimal: string }> = {
    k: { binary: 'Ki', decimal: 'k' },
    m: { binary: 'Mi', decimal: 'M' },
    g: { binary: 'Gi', decimal: 'G' },
    t: { binary: 'Ti', decimal: 'T' },
    p: { binary: 'Pi', decimal: 'P' },
    e: { binary: 'Ei', decimal: 'E' },
  };
  const entry = single[normalised];
  if (entry) {
    if (hadByteSuffix) return `${numberPart}${entry.binary}`;
    // "128MB" handled above; a bare wrong-case unit like "128gi" is covered by
    // the binary table, so what remains is e.g. "5K" -> "5k".
    return `${numberPart}${entry.decimal}`;
  }
  return undefined;
}

/** Render a byte count the way a human would write it, for fix suggestions. */
export function formatBytes(value: number): string {
  const units: [number, string][] = [
    [BINARY_SI.Gi!, 'Gi'],
    [BINARY_SI.Mi!, 'Mi'],
    [BINARY_SI.Ki!, 'Ki'],
  ];
  for (const [size, unit] of units) {
    if (value >= size && value % size === 0) return `${value / size}${unit}`;
  }
  for (const [size, unit] of units) {
    if (value >= size) return `${Math.round((value / size) * 100) / 100}${unit}`;
  }
  return String(value);
}
