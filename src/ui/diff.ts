export type DiffKind = 'context' | 'added' | 'removed';
export type DiffLine = { kind: DiffKind; text: string; number?: number };

interface AlignedLine {
  kind: DiffKind;
  text: string;
  /** 0-based line index in the "after" text; only set for kept and added lines. */
  after?: number;
}

/** Align two texts line by line via longest common subsequence. */
function align(before: string, after: string): AlignedLine[] {
  const a = before.split('\n');
  const b = after.split('\n');

  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i]![j] =
        a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }

  const result: AlignedLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ kind: 'context', text: a[i]!, after: j });
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      result.push({ kind: 'removed', text: a[i]! });
      i++;
    } else {
      result.push({ kind: 'added', text: b[j]!, after: j });
      j++;
    }
  }
  while (i < a.length) result.push({ kind: 'removed', text: a[i++]! });
  while (j < b.length) result.push({ kind: 'added', text: b[j]!, after: j++ });

  return result;
}

/**
 * Line diff trimmed to the neighbourhood of each change, so a fix preview
 * shows the edit rather than the whole manifest.
 */
export function diffLines(before: string, after: string, context = 2): DiffLine[] {
  const aligned = align(before, after).map<DiffLine>((line) => ({
    kind: line.kind,
    text: line.text,
    ...(line.after !== undefined ? { number: line.after + 1 } : {}),
  }));
  return trimToChanges(aligned, context);
}

/**
 * Which lines of `after` are new or rewritten, 1-based. Used to highlight what
 * a fix actually changed, so applying one is visible in the editor.
 */
export function changedLineNumbers(before: string, after: string): number[] {
  return align(before, after)
    .filter((line) => line.kind === 'added' && line.after !== undefined)
    .map((line) => line.after! + 1);
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
