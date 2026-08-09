import {
  parseAllDocuments,
  isMap,
  isSeq,
  isScalar,
  type Document,
  type Node,
  type Pair,
} from 'yaml';
import type { Finding, LocatedFinding, Path } from './types.js';

/**
 * The apiserver decodes manifests through sigs.k8s.io/yaml, which is YAML 1.1.
 * Parsing as 1.2 would disagree with the cluster on bare `yes`/`no`/`on`/`off`
 * (booleans in 1.1, strings in 1.2), so we match the server and let the schema
 * layer report the resulting type mismatch.
 */
export const YAML_VERSION = '1.1' as const;

export interface ParsedDoc {
  index: number;
  doc: Document.Parsed;
  /** Plain JS view of the document, or undefined when it is empty. */
  value: unknown;
  /** Syntax-level problems; when non-empty the value is unreliable. */
  syntaxFindings: Finding[];
  empty: boolean;
}

export function parseDocuments(text: string): ParsedDoc[] {
  const docs = parseAllDocuments(text, {
    version: YAML_VERSION,
    keepSourceTokens: true,
    // Duplicate keys are a hard error in the apiserver's strict decoder too,
    // but we want to keep parsing so the rest of the document still lints.
    uniqueKeys: false,
  });

  return docs.map((doc, index) => {
    const syntaxFindings: Finding[] = doc.errors.map((err) => ({
      ruleId: 'yaml/syntax',
      severity: 'error' as const,
      path: [],
      message: err.message,
      explanation:
        'The document could not be parsed as YAML, so no further checks could run on it. Fix the syntax error and lint again.',
    }));
    const empty = doc.contents == null;
    return {
      index,
      doc,
      value: empty ? undefined : doc.toJS({ maxAliasCount: 100 }),
      syntaxFindings,
      empty,
    };
  });
}

/** Detect duplicate mapping keys, which YAML allows but Kubernetes rejects. */
export function findDuplicateKeys(doc: Document.Parsed): Finding[] {
  const findings: Finding[] = [];
  const visitMap = (node: unknown, path: Path): void => {
    if (isMap(node)) {
      const seen = new Set<string>();
      for (const item of node.items as Pair<unknown, unknown>[]) {
        const key = isScalar(item.key) ? String(item.key.value) : undefined;
        if (key !== undefined) {
          if (seen.has(key)) {
            findings.push({
              ruleId: 'yaml/duplicate-key',
              severity: 'error',
              path: [...path, key],
              anchor: 'key',
              message: `Duplicate key "${key}". The last occurrence silently wins.`,
              explanation:
                'Kubernetes decodes manifests in strict mode and rejects duplicate fields. Remove the redundant entry.',
            });
          }
          seen.add(key);
          visitMap(item.value, [...path, key]);
        }
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => visitMap(item, [...path, i]));
    }
  };
  visitMap(doc.contents, []);
  return findings;
}

interface ResolvedNode {
  /** How many path segments were matched before resolution stopped. */
  depth: number;
  valueNode: Node | null;
  keyNode: Node | null;
}

/** Walk a path as far as the document allows, reporting where it stopped. */
function resolvePath(doc: Document.Parsed, path: Path): ResolvedNode {
  let valueNode: Node | null = (doc.contents as Node | null) ?? null;
  let keyNode: Node | null = null;
  let depth = 0;

  for (const segment of path) {
    if (isMap(valueNode)) {
      const pair = (valueNode.items as Pair<unknown, unknown>[]).find(
        (item) => isScalar(item.key) && String(item.key.value) === String(segment),
      );
      if (!pair) break;
      keyNode = (pair.key as Node) ?? null;
      valueNode = (pair.value as Node | null) ?? null;
    } else if (isSeq(valueNode)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= valueNode.items.length) break;
      keyNode = null;
      valueNode = (valueNode.items[index] as Node | null) ?? null;
    } else {
      break;
    }
    depth += 1;
  }

  return { depth, valueNode, keyNode };
}

function rangeOf(node: Node | null): [number, number] | null {
  const range = node?.range;
  if (!range) return null;
  // yaml ranges are [start, value-end, node-end]; the third includes trailing
  // whitespace and comments, which would over-highlight.
  return [range[0], range[1]];
}

/**
 * Map a finding onto a character range. Falls back to the closest resolvable
 * ancestor so that "missing required field" lands on the parent key rather
 * than at the top of the file.
 */
export function locate(
  parsed: ParsedDoc,
  finding: Finding,
  text: string,
): LocatedFinding {
  const { doc } = parsed;
  const { depth, valueNode, keyNode } = resolvePath(doc, finding.path);
  const fullyResolved = depth === finding.path.length;

  let range: [number, number] | null = null;
  if (fullyResolved) {
    // A key with no value (`image:`) has a null value node; anchor on the key.
    const preferKey = finding.anchor === 'key' || valueNode === null;
    range = (preferKey ? rangeOf(keyNode) : rangeOf(valueNode)) ?? rangeOf(valueNode) ?? rangeOf(keyNode);
  } else {
    range = rangeOf(keyNode) ?? rangeOf(valueNode);
  }
  if (!range) {
    const docRange = doc.range;
    range = docRange ? [docRange[0], Math.max(docRange[0], docRange[1])] : [0, 0];
  }

  let [from, to] = range;
  from = Math.max(0, Math.min(from, text.length));
  to = Math.max(from, Math.min(to, text.length));

  // Keep every marker to a single line. A finding on a mapping or a sequence
  // resolves to the whole collection, which would otherwise draw a squiggle
  // across dozens of lines and read as though the entire file were wrong.
  const endOfLine = text.indexOf('\n', from);
  const lineLimit = endOfLine === -1 ? text.length : endOfLine;
  to = Math.min(to, lineLimit);

  // Never emit a zero-width marker: CodeMirror renders it as an invisible
  // squiggle. Widen to the end of the line, or at least one character.
  if (to === from) {
    to = lineLimit > from ? lineLimit : Math.min(text.length, from + 1);
  }

  const { line, column } = offsetToLineColumn(text, from);
  return { ...finding, from, to, line, column, docIndex: parsed.index };
}

export interface PathAtOffset {
  path: Path;
  /** Range of the key the offset falls in, for highlighting the hover target. */
  from: number;
  to: number;
  /** The `kind` of the document the offset falls in, so the caller can pick a schema. */
  kind?: string;
}

/**
 * Which field is the cursor on? Used for the hover tooltip, which explains a
 * field straight from the API description.
 */
export function pathAtOffset(text: string, offset: number): PathAtOffset | undefined {
  const docs = parseAllDocuments(text, { version: YAML_VERSION, uniqueKeys: false });

  for (const doc of docs) {
    const found = search((doc.contents as Node | null) ?? null, []);
    if (found) {
      const kind = doc.get('kind');
      return typeof kind === 'string' ? { ...found, kind } : found;
    }
  }
  return undefined;

  function search(node: Node | null, path: Path): PathAtOffset | undefined {
    if (isMap(node)) {
      for (const item of node.items as Pair<unknown, unknown>[]) {
        const key = item.key as Node | null;
        const value = item.value as Node | null;
        if (isScalar(key) && key.range && offset >= key.range[0] && offset <= key.range[1]) {
          return { path: [...path, String(key.value)], from: key.range[0], to: key.range[1] };
        }
        if (isScalar(key) && value?.range && offset >= value.range[0] && offset <= value.range[1]) {
          const childPath: Path = [...path, String(key.value)];
          return search(value, childPath) ?? { path: childPath, from: value.range[0], to: value.range[1] };
        }
      }
      return undefined;
    }

    if (isSeq(node)) {
      for (const [index, item] of node.items.entries()) {
        const child = item as Node | null;
        if (child?.range && offset >= child.range[0] && offset <= child.range[1]) {
          return search(child, [...path, index]);
        }
      }
    }
    return undefined;
  }
}

export function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/** Position of a YAML syntax error, which carries its own offsets. */
export function locateSyntaxError(
  parsed: ParsedDoc,
  finding: Finding,
  errorIndex: number,
  text: string,
): LocatedFinding {
  const err = parsed.doc.errors[errorIndex];
  const from = Math.min(err?.pos?.[0] ?? 0, text.length);
  const to = Math.max(from, Math.min(err?.pos?.[1] ?? from + 1, text.length));
  const { line, column } = offsetToLineColumn(text, from);
  return { ...finding, from, to, line, column, docIndex: parsed.index };
}
