import { isDNS1123Label } from '../../k8s/names.js';
import { didYouMean } from '../suggest.js';
import { asArray, asObject, asString, type Rule, type RuleContext } from './context.js';
import { checkClaimSpec } from './persistentvolumeclaim.js';

const VOLUME_DEFINITION = 'io.k8s.api.core.v1.Volume';

export const volumesRule: Rule = {
  id: 'pod/volumes',
  run(ctx: RuleContext) {
    // Volume source fields come from the schema rather than a hardcoded list,
    // so new volume types are handled the moment the schema is regenerated.
    const sourceFields = Object.keys(ctx.schema.definition(VOLUME_DEFINITION)?.properties ?? {}).filter(
      (field) => field !== 'name',
    );

    // A StatefulSet's controller adds one volume per volumeClaimTemplate to
    // every Pod it creates, so those names are mountable even though the pod
    // spec never lists them.
    const declared = new Set<string>(ctx.generatedVolumes);
    const volumes = asArray(ctx.spec['volumes']) ?? [];

    volumes.forEach((entry, index) => {
      const volume = asObject(entry);
      if (!volume) return;
      const path = ctx.at('volumes', index);
      const name = asString(volume['name']);

      if (name !== undefined) {
        declared.add(name);
        const check = isDNS1123Label(name);
        if (!check.ok) {
          ctx.report({
            ruleId: 'pod/invalid-volume-name',
            severity: 'error',
            path: [...path, 'name'],
            message: `"${name}" is not a valid volume name: it ${check.reason}.`,
            explanation:
              'Volume names are DNS labels: lowercase letters, digits and "-", at most 63 characters.',
          });
        }
      }

      const present = sourceFields.filter((field) => volume[field] !== undefined);
      if (present.length === 0) {
        ctx.report({
          ruleId: 'pod/volume-without-source',
          severity: 'error',
          path,
          message: `Volume ${name ? `"${name}"` : `#${index + 1}`} does not specify a source.`,
          explanation:
            'A volume must say where its data comes from — emptyDir, configMap, secret, persistentVolumeClaim, hostPath and so on. Exactly one source is required.',
          docsUrl: 'https://kubernetes.io/docs/concepts/storage/volumes/',
          fix: {
            title: 'Use an emptyDir',
            safe: false,
            ops: [{ op: 'set', path: [...path, 'emptyDir'], value: {} }],
          },
        });
      } else if (present.length > 1) {
        ctx.report({
          ruleId: 'pod/volume-multiple-sources',
          severity: 'error',
          path,
          message: `Volume ${name ? `"${name}"` : `#${index + 1}`} specifies ${present.length} sources (${present.join(', ')}); exactly one is allowed.`,
          explanation: 'Split these into separate volumes, each with its own name and single source.',
        });
      }

      // The apiserver validates this spec with the very same function a
      // PersistentVolumeClaim's own spec goes through.
      const claimTemplate = asObject(asObject(volume['ephemeral'])?.['volumeClaimTemplate']);
      const claimSpec = asObject(claimTemplate?.['spec']);
      if (claimSpec) {
        checkClaimSpec(ctx, claimSpec, [...path, 'ephemeral', 'volumeClaimTemplate', 'spec']);
      }
    });

    for (const ref of ctx.containers) {
      const mountPaths = new Map<string, number>();

      asArray(ref.container['volumeMounts'])?.forEach((entry, index) => {
        const mount = asObject(entry);
        if (!mount) return;
        const path = [...ref.path, 'volumeMounts', index];

        checkVolumeReference(ctx, mount, path, declared, 'volumeMounts');

        const mountPath = asString(mount['mountPath']);
        if (mountPath !== undefined) {
          if (!mountPath.startsWith('/')) {
            ctx.report({
              ruleId: 'pod/relative-mount-path',
              severity: 'error',
              path: [...path, 'mountPath'],
              message: `mountPath "${mountPath}" must be an absolute path.`,
              explanation: 'Mount points are absolute paths inside the container filesystem.',
              fix: {
                title: `Change to "/${mountPath.replace(/^\.?\/*/, '')}"`,
                safe: false,
                ops: [{ op: 'set', path: [...path, 'mountPath'], value: `/${mountPath.replace(/^\.?\/*/, '')}` }],
              },
            });
          }
          if (mountPath.includes(':')) {
            ctx.report({
              ruleId: 'pod/invalid-mount-path',
              severity: 'error',
              path: [...path, 'mountPath'],
              message: `mountPath "${mountPath}" must not contain ":".`,
              explanation: 'A colon is not permitted in a mount path.',
            });
          }

          const previous = mountPaths.get(mountPath);
          if (previous !== undefined) {
            ctx.report({
              ruleId: 'pod/duplicate-mount-path',
              severity: 'error',
              path: [...path, 'mountPath'],
              message: `mountPath "${mountPath}" is already used by volumeMount ${previous + 1} in this container.`,
              explanation:
                'Two volumes cannot be mounted at the same location in one container — the second would shadow the first.',
            });
          } else {
            mountPaths.set(mountPath, index);
          }
        }

        const subPath = asString(mount['subPath']);
        const subPathExpr = asString(mount['subPathExpr']);
        if (subPath !== undefined && subPathExpr !== undefined) {
          ctx.report({
            ruleId: 'pod/sub-path-and-expr',
            severity: 'error',
            path,
            message: 'subPath and subPathExpr are mutually exclusive.',
            explanation:
              'subPathExpr is the variable-expanding form of subPath; use one or the other.',
            fix: { title: 'Remove subPath', safe: false, ops: [{ op: 'delete', path: [...path, 'subPath'] }] },
          });
        }

        for (const [field, value] of [
          ['subPath', subPath],
          ['subPathExpr', subPathExpr],
        ] as const) {
          if (value === undefined) continue;
          if (value.startsWith('/')) {
            ctx.report({
              ruleId: 'pod/absolute-sub-path',
              severity: 'error',
              path: [...path, field],
              message: `${field} "${value}" must be a relative path.`,
              explanation: 'It selects a path inside the volume, so it is resolved relative to the volume root.',
              fix: {
                title: `Change to "${value.replace(/^\/+/, '')}"`,
                safe: true,
                ops: [{ op: 'set', path: [...path, field], value: value.replace(/^\/+/, '') }],
              },
            });
          }
          if (value.split('/').includes('..')) {
            ctx.report({
              ruleId: 'pod/sub-path-escapes-volume',
              severity: 'error',
              path: [...path, field],
              message: `${field} "${value}" must not contain "..".`,
              explanation: 'Escaping the volume root is rejected by the kubelet.',
            });
          }
        }
      });

      asArray(ref.container['volumeDevices'])?.forEach((entry, index) => {
        const device = asObject(entry);
        if (!device) return;
        checkVolumeReference(ctx, device, [...ref.path, 'volumeDevices', index], declared, 'volumeDevices');
      });
    }
  },
};

function checkVolumeReference(
  ctx: RuleContext,
  mount: Record<string, unknown>,
  path: (string | number)[],
  declared: Set<string>,
  field: string,
): void {
  const name = asString(mount['name']);
  if (name === undefined || declared.has(name)) return;

  const suggestion = didYouMean(name, declared);
  const known = [...declared];

  ctx.report({
    ruleId: 'pod/volume-mount-not-found',
    severity: 'error',
    path: [...path, 'name'],
    message: suggestion
      ? `${field} references volume "${name}", which is not declared. Did you mean "${suggestion}"?`
      : `${field} references volume "${name}", which is not declared in ${ctx.field('volumes')}.`,
    explanation:
      known.length > 0
        ? `The Pod declares: ${known.map((entry) => `"${entry}"`).join(', ')}. A mount can only reference a volume defined on the same Pod.`
        : `The Pod declares no volumes at all. Add the volume under ${ctx.field('volumes')} before mounting it.`,
    docsUrl: 'https://kubernetes.io/docs/concepts/storage/volumes/',
    fix: suggestion
      ? { title: `Change to "${suggestion}"`, safe: true, ops: [{ op: 'set', path: [...path, 'name'], value: suggestion }] }
      : {
          title: `Declare volume "${name}" as an emptyDir`,
          safe: false,
          ops: [{ op: 'insert', path: ctx.at('volumes'), index: Number.MAX_SAFE_INTEGER, value: { name, emptyDir: {} } }],
        },
  });
}
