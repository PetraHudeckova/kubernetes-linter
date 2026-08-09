/** "Did you mean" support for misspelled field names and enum values. */

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

/**
 * Pick the closest candidate, if one is close enough to be worth suggesting.
 * A case-only difference always wins, since that is the most common mistake
 * with Kubernetes' camelCase fields and PascalCase enums.
 */
export function didYouMean(input: string, candidates: Iterable<string>): string | undefined {
  const list = [...candidates];
  const lower = input.toLowerCase();

  const caseMatch = list.find((candidate) => candidate.toLowerCase() === lower);
  if (caseMatch && caseMatch !== input) return caseMatch;

  const threshold = Math.max(2, Math.floor(input.length / 4));
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of list) {
    const distance = levenshtein(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= threshold ? best : undefined;
}
