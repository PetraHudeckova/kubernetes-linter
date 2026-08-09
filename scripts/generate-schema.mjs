#!/usr/bin/env node
/**
 * Extracts the Pod schema from the Kubernetes OpenAPI spec.
 *
 * The upstream swagger.json is ~4 MB and covers 771 definitions. Everything
 * reachable from io.k8s.api.core.v1.Pod is only 134 of them (~50 KB gzipped
 * with descriptions intact), which is small enough to ship to the browser.
 * The descriptions are what let the UI explain a field in the API's own words,
 * so they are kept.
 *
 * Usage: node scripts/generate-schema.mjs [minor-version]   (default 1.36)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DEF = 'io.k8s.api.core.v1.Pod';
const here = dirname(fileURLToPath(import.meta.url));
const version = process.argv[2] ?? '1.36';
const url = `https://raw.githubusercontent.com/kubernetes/kubernetes/release-${version}/api/openapi-spec/swagger.json`;

console.log(`fetching ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
const swagger = await res.json();
const definitions = swagger.definitions;
if (!definitions?.[ROOT_DEF]) throw new Error(`${ROOT_DEF} missing from spec`);

/** Transitive $ref closure from the root definition. */
const reached = new Set();
const walk = (name) => {
  if (reached.has(name)) return;
  const def = definitions[name];
  if (!def) throw new Error(`dangling $ref: ${name}`);
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

const outDir = join(here, '..', 'src', 'schema');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `pod-v${version}.json`);
writeFileSync(outFile, JSON.stringify(bundle, null, 1) + '\n');
console.log(`wrote ${outFile}: ${sorted.length} definitions`);
