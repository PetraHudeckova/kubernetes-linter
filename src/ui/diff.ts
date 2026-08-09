export type DiffLine = { kind: 'context' | 'added' | 'removed'; text: string; number?: number };

/**
 * Line diff via longest common subsequence, trimmed to the neighbourhood of
 * each change so a fix preview shows the edit rather than the whole manifest.
 */
export function diffLines(before: string, after: string, context = 2): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');

  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }

  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      all.push({ kind: 'context', text: a[i]!, number: i + 1 });
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      all.push({ kind: 'removed', text: a[i]!, number: i + 1 });
      i++;
    } else {
      all.push({ kind: 'added', text: b[j]! });
      j++;
    }
  }
  while (i < a.length) all.push({ kind: 'removed', text: a[i]!, number: ++i });
  while (j < b.length) all.push({ kind: 'added', text: b[j++]! });

  return trimToChanges(all, context);
}

function trimToChanges(lines: DiffLine[], context: number): DiffLine[] {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === 'context') return;
    for (let offset = -context; offset <= context; offset++) {
      const target = index + offset;
      if (target >= 0 && target < lines.length) keep.add(target);
    }
  });
  if (keep.size === 0) return [];

  const result: DiffLine[] = [];
  let skipping = false;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (skipping) {
        result.push({ kind: 'context', text: '…' });
        skipping = false;
      }
      result.push(line);
    } else {
      skipping = true;
    }
  });
  return result;
}
