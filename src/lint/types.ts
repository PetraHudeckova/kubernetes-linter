/** Shared vocabulary for both lint layers and the UI. */

export type Severity = 'error' | 'warning' | 'info';

/** Path into the YAML document, e.g. ['spec', 'containers', 0, 'image']. */
export type Path = (string | number)[];

/**
 * A single edit to the YAML document. Ops are applied against the parsed AST
 * rather than the text, so comments and formatting survive.
 */
export type FixOp =
  | { op: 'set'; path: Path; value: unknown }
  | { op: 'delete'; path: Path }
  /** Rename a mapping key, keeping its value node (and thus its comments). */
  | { op: 'rename'; path: Path; to: string }
  /** Insert into a sequence; index beyond the end appends. */
  | { op: 'insert'; path: Path; index: number; value: unknown };

export interface Fix {
  title: string;
  /**
   * Safe fixes are unambiguous corrections (a misspelled key, an invalid enum
   * value with one obvious match) and are eligible for "apply all". Unsafe
   * fixes guess at intent — adding a missing field with a placeholder value,
   * for instance — and must be applied one at a time.
   */
  safe: boolean;
  ops: FixOp[];
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  path: Path;
  message: string;
  /** Why this matters — usually the field's own description from the API spec. */
  explanation?: string;
  docsUrl?: string;
  fix?: Fix;
  /** Anchor the marker on the key rather than the value (unknown/misspelled keys). */
  anchor?: 'key' | 'value';
}

/** A finding resolved to a character range in the source text. */
export interface LocatedFinding extends Finding {
  from: number;
  to: number;
  line: number;
  column: number;
  /** Index of the YAML document this came from, for multi-document input. */
  docIndex: number;
}
