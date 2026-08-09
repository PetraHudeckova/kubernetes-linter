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
 * Adding a rule pack (security posture, house style) means appending here.
 */
export const RULES: Rule[] = [
  metadataRule,
  containersRule,
  enumRule,
  portsRule,
  envRule,
  volumesRule,
  resourcesRule,
  probesRule,
  schedulingRule,
  securityContextRule,
  podSpecRule,
];
