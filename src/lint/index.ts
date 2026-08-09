import { lintSchema, isPlainObject, listKinds, type Schema } from './schema.js';
import { KINDS } from './kinds.js';
import { defaultSchema } from './schemas.js';
import { parseDocuments, findDuplicateKeys, locate, locateSyntaxError, type ParsedDoc } from './parse.js';
import { createContext } from './rules/context.js';
import { POD_RULES, RULES } from './rules/registry.js';
import { applyFix } from './fix.js';
import type { Finding, LocatedFinding } from './types.js';

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

export interface LintResult {
  findings: LocatedFinding[];
  /** Number of YAML documents in the input. */
  documentCount: number;
  errors: number;
  warnings: number;
  infos: number;
}

/** Lint against a specific Kubernetes version; defaults to the newest bundled one. */
export function lint(text: string, schema: Schema = defaultSchema): LintResult {
  const findings: LocatedFinding[] = [];
  const parsedDocs = parseDocuments(text);

  for (const parsed of parsedDocs) {
    if (parsed.syntaxFindings.length > 0) {
      parsed.syntaxFindings.forEach((finding, index) => {
        findings.push(locateSyntaxError(parsed, finding, index, text));
      });
      continue;
    }
    if (parsed.empty) continue;

    for (const finding of lintOne(parsed, schema)) {
      findings.push(locate(parsed, finding, text));
    }
  }

  findings.sort(
    (a, b) => a.from - b.from || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  return {
    findings,
    documentCount: parsedDocs.filter((doc) => !doc.empty).length,
    errors: findings.filter((finding) => finding.severity === 'error').length,
    warnings: findings.filter((finding) => finding.severity === 'warning').length,
    infos: findings.filter((finding) => finding.severity === 'info').length,
  };
}

function lintOne(parsed: ParsedDoc, schema: Schema): Finding[] {
  const findings: Finding[] = findDuplicateKeys(parsed.doc);
  const value = parsed.value;

  const result = lintSchema(value, schema);
  findings.push(...result.findings);

  if (result.unsupportedKind !== undefined) {
    findings.push({
      ruleId: 'lint/unsupported-kind',
      severity: 'info',
      path: ['kind'],
      message: `This linter understands ${listKinds(schema.kinds)}, so "${result.unsupportedKind}" was not checked.`,
      explanation:
        'Other workload controllers — CronJob, ReplicaSet — embed a Pod template the same way a Deployment or a Job does. You can lint that template on its own by pasting it as a Pod, with the template\'s metadata and spec under a "kind: Pod" document.',
    });
    return findings;
  }

  if (!isPlainObject(value)) return findings;

  const kind = result.kind === undefined ? undefined : KINDS[result.kind];
  if (!kind) return findings;

  const kindSchema = schema.for(kind.kind);
  if (!kindSchema) return findings;

  const ctx = createContext(value, kind, kindSchema, findings);
  const podRules = kind.podTemplate ? POD_RULES : [];
  for (const rule of [...RULES, ...podRules, ...kind.rules]) rule.run(ctx);

  return findings;
}

/**
 * Apply every safe fix, re-linting after each one because a fix can shift the
 * paths that later findings refer to. Runs to a fixed point, with a cap so a
 * pathological input cannot loop forever.
 */
export function applySafeFixes(
  text: string,
  schema: Schema = defaultSchema,
  maxPasses = 50,
): { text: string; applied: number } {
  let current = text;
  let applied = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    const { findings } = lint(current, schema);
    const next = findings.find((finding) => finding.fix?.safe);
    if (!next?.fix) break;

    const updated = applyFix(current, next.fix, next.docIndex);
    // A fix that changes nothing would spin forever.
    if (updated === current) break;
    current = updated;
    applied += 1;
  }

  return { text: current, applied };
}

export { applyFix } from './fix.js';
export {
  AVAILABLE_VERSIONS,
  DEFAULT_VERSION,
  defaultSchema,
  isKnownVersion,
  loadSchema,
} from './schemas.js';
export type { Schema } from './schema.js';
export type { Finding, LocatedFinding, Fix, Severity } from './types.js';
