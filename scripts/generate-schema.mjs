#!/usr/bin/env node
/**
 * Extracts the schemas the linter understands from the Kubernetes OpenAPI
 * spec, one file per supported minor version.
 *
 * The upstream swagger.json is ~4 MB and covers 500-770 definitions depending
 * on the release. Everything reachable from the roots below is only ~120-160
 * of them (~35 KB brotli with descriptions intact), which is small enough to
 * ship to the browser. The descriptions are what let the UI explain a field in
 * the API's own words, so they are kept.
 *
 * One bundle carries every root because the closures overlap almost entirely:
 * a Deployment reaches PodSpec through PodTemplateSpec, and a StatefulSet adds
 * little beyond its own spec plus PersistentVolumeClaim, so the union is only
 * a dozen or so definitions wider than Pod's alone. A Job is the same story —
 * it reaches PodSpec the same way and adds only its own spec, its failure and
 * success policies and their rules. Service is the one root that shares nothing
 * below metadata, and it still costs under ten definitions; IngressClass costs
 * two, both of them its own. Separate per-kind files would be near-duplicates,
 * and a single bundle also means lint() can switch kinds mid-document without
 * loading anything.
 *
 * Usage:
 *   node scripts/generate-schema.mjs                # every supported version
 *   node scripts/generate-schema.mjs 1.37           # one version
 *   node scripts/generate-schema.mjs 1.30 1.31      # a list
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Kind name -> definition. The kind names are the contract with
 * `src/lint/kinds.ts`, which pairs each with the path to its pod spec.
 */
const ROOTS = {
  Pod: 'io.k8s.api.core.v1.Pod',
  Deployment: 'io.k8s.api.apps.v1.Deployment',
  StatefulSet: 'io.k8s.api.apps.v1.StatefulSet',
  DaemonSet: 'io.k8s.api.apps.v1.DaemonSet',
  Job: 'io.k8s.api.batch.v1.Job',
  Service: 'io.k8s.api.core.v1.Service',
  Ingress: 'io.k8s.api.networking.v1.Ingress',
  IngressClass: 'io.k8s.api.networking.v1.IngressClass',
};

/**
 * 1.25 is the floor: it is the first release after PodSecurityPolicy was
 * removed, and covers what clusters in the wild still run. Older releases
 * would mean shipping long-dead APIs.
 */
const OLDEST_MINOR = 25;
const NEWEST_MINOR = 36;

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'src', 'schema');

const versions =
  process.argv.length > 2
    ? process.argv.slice(2)
    : Array.from({ length: NEWEST_MINOR - OLDEST_MINOR + 1 }, (_, i) => `1.${OLDEST_MINOR + i}`);

mkdirSync(outDir, { recursive: true });

for (const version of versions) {
  const url = `https://raw.githubusercontent.com/kubernetes/kubernetes/release-${version}/api/openapi-spec/swagger.json`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed for ${version}: ${res.status} ${res.statusText}`);
  const { definitions } = await res.json();
  for (const root of Object.values(ROOTS)) {
    if (!definitions?.[root]) throw new Error(`${root} missing from the ${version} spec`);
  }

  /** Transitive $ref closure, unioned across every root. */
  const reached = new Set();
  const walk = (name) => {
    if (reached.has(name)) return;
    const def = definitions[name];
    if (!def) throw new Error(`dangling $ref in ${version}: ${name}`);
    reached.add(name);
    const stack = [def];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) {
        stack.push(...node.filter((v) => v && typeof v === 'object'));
      } else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref' && typeof value === 'string') walk(value.split('/').pop());
          else if (value && typeof value === 'object') stack.push(value);
        }
      }
    }
  };
  for (const root of Object.values(ROOTS)) walk(root);

  const sorted = [...reached].sort();
  const bundle = {
    k8sVersion: version,
    source: url,
    generatedAt: new Date().toISOString().slice(0, 10),
    roots: ROOTS,
    definitions: Object.fromEntries(sorted.map((name) => [name, definitions[name]])),
  };

  const outFile = join(outDir, `k8s-${version}.json`);
  writeFileSync(outFile, JSON.stringify(bundle, null, 1) + '\n');
  console.log(`k8s-${version}.json: ${sorted.length} definitions`);
}
