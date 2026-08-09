import type { Rule } from './context.js';
import { containersRule } from './containers.js';
import { enumRule } from './enums.js';
import { envRule } from './env.js';
import { metadataRule } from './metadata.js';
import { podSpecRule } from './podspec.js';
import { portsRule } from './ports.js';
import { probesRule } from './probes.js';
import { resourcesRule } from './resources.js';
import { schedulingRule } from './scheduling.js';
import { securityContextRule } from './security-context.js';
import { volumesRule } from './volumes.js';

/**
 * Layer 2: checks the apiserver performs that OpenAPI cannot express.
 *
 * These two run for every kind: they address the document itself, so they are
 * as correct on a Service as on a Pod. `metadataRule` checks the object's own
 * name and labels; `enumRule` walks the whole document against the schema and
 * so covers every kind's enum fields at once.
 */
export const RULES: Rule[] = [metadataRule, enumRule];

/**
 * Rules that read `ctx.spec` — the PodSpec — and therefore run only for a kind
 * whose descriptor says where one lives. Adding a rule pack (security posture,
 * house style) means appending to one of these two lists.
 */
export const POD_RULES: Rule[] = [
  containersRule,
  portsRule,
  envRule,
  volumesRule,
  resourcesRule,
  probesRule,
  schedulingRule,
  securityContextRule,
  podSpecRule,
];
