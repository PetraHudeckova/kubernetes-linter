import { Schema, type SchemaBundle } from './schema.js';
import defaultBundle from '../schema/k8s-1.36.json' with { type: 'json' };

/**
 * Per-version schema bundles, loaded on demand. One bundle covers every
 * supported kind (see `roots` in the generated files), so the kind a document
 * declares never triggers a second fetch.
 *
 * `import.meta.glob` is deliberate: Vite rewrites the emitted asset URLs for
 * the configured `base`, so the chunks resolve correctly under the project
 * page's `/kubernetes-linter/` sub-path. A hand-built `fetch('/schema/...')`
 * would 404 there.
 *
 * The glob is lazy — each file becomes its own chunk, fetched only when that
 * version is selected. The default version is additionally imported
 * statically, so the first lint needs no network round trip. That does leave
 * an unused chunk for the default version in `dist`; it costs nothing to load
 * and keeps the version list derived from one glob rather than hand-listed.
 */
const chunks = import.meta.glob<{ default: unknown }>('../schema/k8s-*.json');

const CHUNK_PATTERN = /k8s-(\d+\.\d+)\.json$/;

export const DEFAULT_VERSION: string = (defaultBundle as unknown as SchemaBundle).k8sVersion;

export const defaultSchema = new Schema(defaultBundle as unknown as SchemaBundle);

/** Every bundled version, newest first. */
export const AVAILABLE_VERSIONS: string[] = Object.keys(chunks)
  .map((path) => CHUNK_PATTERN.exec(path)?.[1])
  .filter((version): version is string => version !== undefined)
  .sort((a, b) => minor(b) - minor(a));

function minor(version: string): number {
  return Number(version.split('.')[1] ?? 0);
}

const cache = new Map<string, Schema>([[DEFAULT_VERSION, defaultSchema]]);

export function isKnownVersion(version: string): boolean {
  return AVAILABLE_VERSIONS.includes(version);
}

/** Resolve a version to its schema, fetching the chunk the first time. */
export async function loadSchema(version: string): Promise<Schema> {
  const cached = cache.get(version);
  if (cached) return cached;

  const load = chunks[`../schema/k8s-${version}.json`];
  if (!load) throw new Error(`No schema bundled for Kubernetes ${version}`);

  const module = await load();
  const schema = new Schema(module.default as SchemaBundle);
  cache.set(version, schema);
  return schema;
}
