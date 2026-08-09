import { isDNS1123Label, isDNS1123Subdomain } from '../../k8s/names.js';
import type { Path } from '../types.js';
import { asObject, asString, type Rule, type RuleContext } from './context.js';

const CLASS_DOCS = 'https://kubernetes.io/docs/concepts/services-networking/ingress/#ingress-class';
const PARAMETERS_DOCS =
  'https://kubernetes.io/docs/concepts/services-networking/ingress/#ingressclass-scope';
const DEFAULT_CLASS_DOCS =
  'https://kubernetes.io/docs/concepts/services-networking/ingress/#default-ingressclass';

/** maxLenIngressClassController, from pkg/apis/networking/validation. */
const CONTROLLER_MAX = 250;

/** The annotation that marks one IngressClass as the cluster's default. */
const DEFAULT_CLASS_ANNOTATION = 'ingressclass.kubernetes.io/is-default-class';

const SCOPE_CLUSTER = 'Cluster';
const SCOPE_NAMESPACE = 'Namespace';

/**
 * Characters an HTTP path may carry, from IsDomainPrefixedPath in
 * k8s.io/apimachinery/pkg/api/validation. Deliberately not a path check: the
 * apiserver only asks that the part after the domain be spellable in a URL.
 */
const HTTP_PATH = /^[A-Za-z0-9/\-._~%!$&'()*+,;=:]+$/;

/**
 * The checks the apiserver runs on an IngressClass, from ValidateIngressClass
 * in pkg/apis/networking/validation. Like a Service or an Ingress it describes
 * no Pod, so none of the shared PodSpec rules apply.
 *
 * The schema layer covers almost nothing here: IngressClassSpec has no required
 * fields at all, so `controller` — which validation does require — is this
 * module's, as is every rule about `parameters`, whose two required fields the
 * schema can only see the presence of and not the contents. The one exception
 * is `parameters.scope`, an enum, which the enum table already reports.
 *
 * Nothing is version-gated: networking/v1 IngressClass has been served
 * unchanged since 1.19, scope and namespace included.
 */
export const ingressClassRule: Rule = {
  id: 'ingressclass/spec',
  run(ctx: RuleContext) {
    checkDefaultAnnotation(ctx);

    // An absent spec is an IngressClass naming no controller, which is the same
    // rejection as an empty one. A spec of the wrong shape is layer 1's.
    const declared = ctx.doc['spec'];
    const spec = declared == null ? {} : asObject(declared);
    if (!spec) return;

    checkController(ctx, spec);
    checkParameters(ctx, spec);
  },
};

/* Controller */

/**
 * The controller is what the class means: an Ingress naming this class is
 * picked up by whichever controller answers to this string. It is a
 * domain-prefixed path rather than a bare name so that two implementations
 * cannot collide, and it is immutable once created.
 */
function checkController(ctx: RuleContext, spec: Record<string, unknown>): void {
  const controller = asString(spec['controller']);
  const path: Path = ['spec', 'controller'];

  if (controller === undefined || controller === '') {
    ctx.report({
      ruleId: 'ingressclass/missing-controller',
      severity: 'error',
      path: controller === undefined ? ['spec'] : path,
      ...(controller === undefined ? { anchor: 'key' as const } : {}),
      message: 'An IngressClass must name the controller that implements it.',
      explanation:
        'The class exists to point an Ingress at an implementation, and spec.controller is that pointer — "k8s.io/ingress-nginx", say, or "traefik.io/ingress-controller". Without it no controller claims the Ingresses that name this class, and the apiserver rejects the object with "Required value".',
      docsUrl: CLASS_DOCS,
    });
    return;
  }

  if (controller.length > CONTROLLER_MAX) {
    ctx.report({
      ruleId: 'ingressclass/controller-too-long',
      severity: 'error',
      path,
      message: `controller must be at most ${CONTROLLER_MAX} characters, but is ${controller.length}.`,
      explanation:
        'The value is an identifier a controller compares itself against, not a description.',
      docsUrl: CLASS_DOCS,
    });
    return;
  }

  const slash = controller.indexOf('/');
  const domain = slash === -1 ? '' : controller.slice(0, slash);
  const rest = slash === -1 ? '' : controller.slice(slash + 1);

  if (domain === '' || rest === '') {
    ctx.report({
      ruleId: 'ingressclass/invalid-controller',
      severity: 'error',
      path,
      message: `"${controller}" is not a domain-prefixed path.`,
      explanation:
        'The value is a domain the implementation owns, a "/", and a name below it — "k8s.io/ingress-nginx". The prefix is what keeps two implementations from claiming the same string; a bare name has no owner and is rejected.',
      docsUrl: CLASS_DOCS,
    });
    return;
  }

  const check = isDNS1123Subdomain(domain);
  if (!check.ok) {
    ctx.report({
      ruleId: 'ingressclass/invalid-controller',
      severity: 'error',
      path,
      message: `"${domain}" is not a valid domain prefix: it ${check.reason}.`,
      explanation:
        'Everything before the first "/" is a DNS subdomain naming the implementation\'s owner: lowercase letters, digits, "-" and ".", starting and ending with an alphanumeric character.',
      docsUrl: CLASS_DOCS,
    });
    return;
  }

  if (!HTTP_PATH.test(rest)) {
    ctx.report({
      ruleId: 'ingressclass/invalid-controller',
      severity: 'error',
      path,
      message: `"${rest}" is not a valid path: it must contain only characters allowed in a URL path.`,
      explanation:
        'Everything after the domain is checked as an HTTP path, so it may carry letters, digits and the punctuation a URL permits — but no spaces and no characters that would have to be escaped.',
      docsUrl: CLASS_DOCS,
    });
  }
}

/* Parameters */

/**
 * The parameters reference points at a second object holding the controller's
 * own configuration. `kind` and `name` are required by the schema, so only
 * their emptiness is checked here; the scope is what decides whether a
 * namespace may accompany them, and it defaults to Cluster.
 */
function checkParameters(ctx: RuleContext, spec: Record<string, unknown>): void {
  const parameters = asObject(spec['parameters']);
  if (!parameters) return;

  const base: Path = ['spec', 'parameters'];

  const apiGroup = asString(parameters['apiGroup']);
  if (apiGroup !== undefined) {
    const check = isDNS1123Subdomain(apiGroup);
    if (!check.ok) {
      ctx.report({
        ruleId: 'ingressclass/invalid-parameters-api-group',
        severity: 'error',
        path: [...base, 'apiGroup'],
        message:
          apiGroup === ''
            ? 'apiGroup is empty; leave it out to mean the core API group.'
            : `"${apiGroup}" is not a valid API group: it ${check.reason}.`,
        explanation:
          'The group is the one the referenced object is served under — "k8s.example.com" for a custom resource. The apiserver validates it as a DNS subdomain, so an empty string is rejected rather than read as the core group; omitting the field is how the core group is named.',
        docsUrl: PARAMETERS_DOCS,
        fix:
          apiGroup === ''
            ? {
                title: 'Remove apiGroup',
                safe: false,
                ops: [{ op: 'delete', path: [...base, 'apiGroup'] }],
              }
            : undefined,
      });
    }
  }

  for (const field of ['kind', 'name'] as const) {
    checkPathSegment(ctx, parameters[field], [...base, field], field);
  }

  checkParametersScope(ctx, parameters, base);
}

/**
 * Kind and name become path segments in the URL the controller fetches the
 * object from, which is what IsValidPathSegmentName checks: no "/", no "%",
 * and neither "." nor "..".
 */
function checkPathSegment(ctx: RuleContext, value: unknown, path: Path, field: string): void {
  const text = asString(value);
  if (text === undefined) return;

  if (text === '') {
    ctx.report({
      ruleId: 'ingressclass/empty-parameters-reference',
      severity: 'error',
      path,
      message: `parameters.${field} is empty.`,
      explanation:
        'A parameters reference is only useful if it resolves to an object, so both the kind and the name of that object are required. The apiserver rejects an empty one with "Required value", exactly as it rejects a missing one.',
      docsUrl: PARAMETERS_DOCS,
    });
    return;
  }

  const reason =
    text === '.' || text === '..'
      ? `must not be "${text}"`
      : text.includes('/')
        ? 'must not contain "/"'
        : text.includes('%')
          ? 'must not contain "%"'
          : undefined;
  if (reason === undefined) return;

  ctx.report({
    ruleId: 'ingressclass/invalid-parameters-reference',
    severity: 'error',
    path,
    message: `"${text}" is not a valid ${field}: it ${reason}.`,
    explanation:
      'The value becomes a segment of the URL the object is read from, so it cannot carry a separator, an escape, or the two names that mean "here" and "one level up".',
    docsUrl: PARAMETERS_DOCS,
  });
}

function checkParametersScope(
  ctx: RuleContext,
  parameters: Record<string, unknown>,
  base: Path,
): void {
  const declared = asString(parameters['scope']);
  // An unrecognised scope is the enum table's report; without knowing which of
  // the two was meant there is nothing to say about the namespace beside it.
  if (declared !== undefined && declared !== SCOPE_CLUSTER && declared !== SCOPE_NAMESPACE) return;
  const scope = declared ?? SCOPE_CLUSTER;

  const namespace = asString(parameters['namespace']);

  if (scope === SCOPE_NAMESPACE) {
    if (namespace === undefined || namespace === '') {
      ctx.report({
        ruleId: 'ingressclass/missing-parameters-namespace',
        severity: 'error',
        path: namespace === undefined ? base : [...base, 'namespace'],
        ...(namespace === undefined ? { anchor: 'key' as const } : {}),
        message: 'A "Namespace" scoped parameters reference must say which namespace.',
        explanation:
          'An IngressClass is cluster-scoped, so a reference from it to a namespaced object carries no namespace of its own to fall back on. The apiserver rejects the pair with "`parameters.scope` is set to \'Namespace\'".',
        docsUrl: PARAMETERS_DOCS,
      });
      return;
    }

    const check = isDNS1123Label(namespace);
    if (!check.ok) {
      ctx.report({
        ruleId: 'ingressclass/invalid-parameters-namespace',
        severity: 'error',
        path: [...base, 'namespace'],
        message: `"${namespace}" is not a valid namespace: it ${check.reason}.`,
        explanation:
          'Namespace names are DNS labels: lowercase letters, digits and "-", at most 63 characters.',
        docsUrl: PARAMETERS_DOCS,
      });
    }
    return;
  }

  if (namespace === undefined) return;

  ctx.report({
    ruleId: 'ingressclass/parameters-namespace-not-allowed',
    severity: 'error',
    path: [...base, 'namespace'],
    message:
      declared === undefined
        ? 'parameters.namespace needs parameters.scope: Namespace, which defaults to "Cluster".'
        : 'parameters.namespace may not be set when parameters.scope is "Cluster".',
    explanation:
      'A "Cluster" scoped reference resolves against no namespace at all, so a namespace beside it would be read by nothing. The apiserver rejects the pair rather than ignore the field — and since scope defaults to "Cluster", leaving it out is the same as writing it.',
    docsUrl: PARAMETERS_DOCS,
    fix: {
      title: `Set scope: ${SCOPE_NAMESPACE}`,
      safe: false,
      ops: [{ op: 'set', path: [...base, 'scope'], value: SCOPE_NAMESPACE }],
    },
  });
}

/* Default class annotation */

/**
 * The annotation that makes this class the one an Ingress gets when it names
 * none. Nothing validates it — it is an annotation — but the admission plugin
 * that reads it compares the value to "true" as a string, so anything else is
 * a class that quietly is not the default.
 */
function checkDefaultAnnotation(ctx: RuleContext): void {
  const annotations = asObject(asObject(ctx.doc['metadata'])?.['annotations']);
  const value = asString(annotations?.[DEFAULT_CLASS_ANNOTATION]);
  if (value === undefined || value === 'true' || value === 'false') return;

  // "True" or " true " differ from the annotation the plugin looks for only in
  // case and spacing, so correcting them is unambiguous; "yes" is a guess at
  // what was meant and gets no fix at all.
  const normalised = value.trim().toLowerCase();
  const intended = normalised === 'true' || normalised === 'false' ? normalised : undefined;

  ctx.report({
    ruleId: 'ingressclass/invalid-default-annotation',
    severity: 'warning',
    path: ['metadata', 'annotations', DEFAULT_CLASS_ANNOTATION],
    message: `"${value}" does not mark this class as the default; only the exact string "true" does.`,
    explanation:
      'The admission plugin that fills in a missing spec.ingressClassName compares this annotation to "true" character by character, so "True", "yes" and "1" all read as "not the default" — and an Ingress that names no class is left unclaimed instead.',
    docsUrl: DEFAULT_CLASS_DOCS,
    fix: intended
      ? {
          title: `Change to "${intended}"`,
          safe: true,
          ops: [
            {
              op: 'set',
              path: ['metadata', 'annotations', DEFAULT_CLASS_ANNOTATION],
              value: intended,
            },
          ],
        }
      : undefined,
  });
}
