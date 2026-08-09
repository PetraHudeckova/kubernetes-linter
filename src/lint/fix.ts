import { parseAllDocuments, isMap, isSeq, isScalar, type Document, type Pair, type ToStringOptions } from 'yaml';
import { YAML_VERSION } from './parse.js';
import type { Fix, FixOp, Path } from './types.js';

/**
 * Fixes are applied to the parsed AST and re-emitted, so comments, key order,
 * quoting style and blank lines survive. Indentation is re-derived from the
 * input so a fixed document still looks like the one that was pasted in.
 */
export function detectFormat(text: string): ToStringOptions {
  const lines = text.split('\n');
  let indent = 2;
  let indentSeq = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = /^(\s+)\S/.exec(line);
    if (match && !/^\s*#/.test(line)) {
      const width = match[1]!.length;
      if (width >= 1 && width <= 8) {
        indent = width;
        break;
      }
    }
  }

  for (let i = 1; i < lines.length; i++) {
    const seq = /^(\s*)- /.exec(lines[i]!);
    if (!seq) continue;
    const previous = lines[i - 1]!;
    const parent = /^(\s*)\S.*:\s*$/.exec(previous);
    if (parent) {
      indentSeq = seq[1]!.length > parent[1]!.length;
      break;
    }
  }

  // Keep flow collections looking the way they were written: ["a"] vs [ "a" ].
  const flowCollectionPadding = /[[{] +\S/.test(text);

  return { indent, indentSeq, lineWidth: 0, flowCollectionPadding };
}

/** Apply one fix to the source text, returning the rewritten document. */
export function applyFix(text: string, fix: Fix, docIndex = 0): string {
  return applyOps(text, fix.ops, docIndex);
}

export function applyOps(text: string, ops: FixOp[], docIndex = 0): string {
  const docs = parseAllDocuments(text, { version: YAML_VERSION, keepSourceTokens: true, uniqueKeys: false });
  const doc = docs[docIndex];
  if (!doc) return text;

  for (const op of ops) applyOp(doc, op);

  // Each parsed document re-emits its own "---" marker if the source had one,
  // so the parts concatenate directly.
  const options = detectFormat(text);
  return docs.map((entry) => entry.toString(options)).join('');
}

function applyOp(doc: Document.Parsed, op: FixOp): void {
  switch (op.op) {
    case 'set':
      ensureParents(doc, op.path);
      doc.setIn(op.path, op.value);
      break;

    case 'delete':
      doc.deleteIn(op.path);
      break;

    case 'rename': {
      const parentPath = op.path.slice(0, -1);
      const from = op.path[op.path.length - 1];
      if (from === undefined) break;
      const parent = parentPath.length === 0 ? doc.contents : doc.getIn(parentPath, true);
      if (!isMap(parent)) break;

      const pair = (parent.items as Pair<unknown, unknown>[]).find(
        (item) => isScalar(item.key) && String(item.key.value) === String(from),
      );
      if (!pair) break;

      const alreadyPresent = (parent.items as Pair<unknown, unknown>[]).some(
        (item) => isScalar(item.key) && String(item.key.value) === op.to,
      );
      if (alreadyPresent) {
        // Renaming would create a duplicate key, so the misspelled entry is
        // simply redundant: drop it rather than corrupting the document.
        doc.deleteIn(op.path);
        break;
      }
      if (isScalar(pair.key)) pair.key.value = op.to;
      break;
    }

    case 'insert': {
      const target = op.path.length === 0 ? doc.contents : doc.getIn(op.path, true);
      if (isSeq(target)) {
        const node = doc.createNode(op.value);
        const index = Math.max(0, Math.min(op.index, target.items.length));
        target.items.splice(index, 0, node);
      } else {
        ensureParents(doc, op.path);
        doc.setIn(op.path, [op.value]);
      }
      break;
    }
  }
}

/**
 * Create any missing levels above `path` as plain mappings.
 *
 * setIn would happily do this itself, but it builds intermediate levels out of
 * JavaScript `Map` objects — and under YAML 1.1, which is what the apiserver
 * uses, a `Map` resolves to the `!!omap` tag and serialises as a sequence of
 * single-pair mappings. Creating them from plain objects keeps them plain.
 */
function ensureParents(doc: Document.Parsed, path: Path): void {
  for (let depth = 1; depth < path.length; depth++) {
    const prefix = path.slice(0, depth);
    // createNode makes a real collection node, so the next level can be set
    // into it; a bare `{}` would be stored as an opaque scalar value.
    if (doc.getIn(prefix) == null) doc.setIn(prefix, doc.createNode({}));
  }
}

/** Does this path still resolve? Used to skip fixes invalidated by earlier ones. */
export function pathExists(doc: Document.Parsed, path: Path): boolean {
  if (path.length === 0) return true;
  return doc.hasIn(path);
}
