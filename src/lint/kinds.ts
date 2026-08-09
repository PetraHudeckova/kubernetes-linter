import type { Path } from './types.js';
import type { Rule } from './rules/context.js';
import { deploymentRule } from './rules/deployment.js';

/**
 * What the rule layer needs to know about a kind. Everything else is derived
 * from the schema bundle, which owns the root definition names — a descriptor
 * is keyed by kind name and never repeats a `$ref`.
 *
 * The pod spec is the only thing that moves between kinds: a Pod carries it at
 * `spec`, a Deployment at `spec.template.spec`. Rules address it through
 * `ctx.at(...)`, so adding a kind is a matter of naming those two paths.
 */
export interface KindDescriptor {
  kind: string;
  /** Where the PodSpec sits, relative to the document root. */
  specPath: Path;
  /** Where the pod's own metadata sits, relative to the document root. */
  podMetadataPath: Path;
  /** Rules that only make sense for this kind, run after the shared ones. */
  rules: Rule[];
}

export const KINDS: Record<string, KindDescriptor> = {
  Pod: {
    kind: 'Pod',
    specPath: ['spec'],
    podMetadataPath: ['metadata'],
    rules: [],
  },
  Deployment: {
    kind: 'Deployment',
    specPath: ['spec', 'template', 'spec'],
    podMetadataPath: ['spec', 'template', 'metadata'],
    rules: [deploymentRule],
  },
};

/** Render a pod-spec-relative field for a message, e.g. `spec.template.spec.volumes`. */
export function specField(descriptor: KindDescriptor, ...segments: string[]): string {
  return [...descriptor.specPath, ...segments].join('.');
}
