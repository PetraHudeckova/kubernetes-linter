import podSchema from '../schema/pod-v1.36.json' with { type: 'json' };
import { Schema, lintSchema, isPlainObject, type SchemaBundle } from './schema.js';
import { parseDocuments, findDuplicateKeys, locate, locateSyntaxError, type ParsedDoc } from './parse.js';
import { createContext } from './rules/context.js';
import { RULES } from './rules/registry.js';
import { applyFix } from './fix.js';
import type { Finding, LocatedFinding } from './types.js';

export const schema = new Schema(podSchema as unknown as SchemaBundle);
export const K8S_VERSION = schema.version;

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

export interface LintResult {
  findings: LocatedFinding[];
  /** Number of YAML documents in the input. */
  documentCount: number;
  errors: number;
  warnings: number;
  infos: number;
}

export function lint(text: string): LintResult {
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

    for (const finding of lintOne(parsed)) {
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

function lintOne(parsed: ParsedDoc): Finding[] {
  const findings: Finding[] = findDuplicateKeys(parsed.doc);
  const value = parsed.value;

  const result = lintSchema(value, schema);
  findings.push(...result.findings);

  if (result.unsupportedKind !== undefined) {
    findings.push({
      ruleId: 'lint/unsupported-kind',
      severity: 'info',
      path: ['kind'],
      message: `This linter only understands Pod, so "${result.unsupportedKind}" was not checked.`,
      explanation:
        'Workload controllers such as Deployment, StatefulSet, Job and CronJob embed a Pod template. You can lint the template on its own by pasting it as a Pod, with the template\'s metadata and spec under a "kind: Pod" document.',
    });
    return findings;
  }

  if (!isPlainObject(value)) return findings;

  const ctx = createContext(value, schema, findings);
  for (const rule of RULES) rule.run(ctx);

  return findings;
}

/**
 * Apply every safe fix, re-linting after each one because a fix can shift the
 * paths that later findings refer to. Runs to a fixed point, with a cap so a
 * pathological input cannot loop forever.
 */
export function applySafeFixes(text: string, maxPasses = 50): { text: string; applied: number } {
  let current = text;
  let applied = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    const { findings } = lint(current);
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
export type { Finding, LocatedFinding, Fix, Severity } from './types.js';
