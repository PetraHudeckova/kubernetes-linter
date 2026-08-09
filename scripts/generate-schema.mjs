#!/usr/bin/env node
/**
 * Extracts the Pod schema from the Kubernetes OpenAPI spec, one file per
 * supported minor version.
 *
 * The upstream swagger.json is ~4 MB and covers 500-770 definitions depending
 * on the release. Everything reachable from io.k8s.api.core.v1.Pod is only
 * ~110-135 of them (~33 KB brotli with descriptions intact), which is small
 * enough to ship to the browser. The descriptions are what let the UI explain
 * a field in the API's own words, so they are kept.
 *
 * Usage:
 *   node scripts/generate-schema.mjs                # every supported version
 *   node scripts/generate-schema.mjs 1.37           # one version
 *   node scripts/generate-schema.mjs 1.30 1.31      # a list
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DEF = 'io.k8s.api.core.v1.Pod';

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
  if (!definitions?.[ROOT_DEF]) throw new Error(`${ROOT_DEF} missing from the ${version} spec`);

  /** Transitive $ref closure from the root definition. */
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
  walk(ROOT_DEF);

  const sorted = [...reached].sort();
  const bundle = {
    k8sVersion: version,
    source: url,
    generatedAt: new Date().toISOString().slice(0, 10),
    root: ROOT_DEF,
    definitions: Object.fromEntries(sorted.map((name) => [name, definitions[name]])),
  };

  const outFile = join(outDir, `pod-${version}.json`);
  writeFileSync(outFile, JSON.stringify(bundle, null, 1) + '\n');
  console.log(`pod-${version}.json: ${sorted.length} definitions`);
}
