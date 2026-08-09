import { isIPAddress } from '../../k8s/net.js';
import {
  isDNS1035Label,
  isDNS1123Subdomain,
  isPortName,
  isWildcardDNS1123Subdomain,
} from '../../k8s/names.js';
import type { Path } from '../types.js';
import { asArray, asNumber, asObject, asString, type Rule, type RuleContext } from './context.js';

const INGRESS_DOCS = 'https://kubernetes.io/docs/concepts/services-networking/ingress/';
const PATH_TYPE_DOCS = `${INGRESS_DOCS}#path-types`;
const RULES_DOCS = `${INGRESS_DOCS}#ingress-rules`;
const BACKEND_DOCS = `${INGRESS_DOCS}#default-backend`;
const TLS_DOCS = `${INGRESS_DOCS}#tls`;
const CLASS_DOCS = 'https://kubernetes.io/docs/concepts/services-networking/ingress/#ingress-class';

const MIN_PORT = 1;
const MAX_PORT = 65535;

/** The annotation IngressClass replaced. Deprecated since 1.18, removed from no release. */
const LEGACY_CLASS_ANNOTATION = 'kubernetes.io/ingress.class';

/**
 * Path fragments the apiserver refuses outright in an Exact or Prefix path:
 * a path is matched element by element after being split on "/", so a run that
 * produces an empty or relative element can never match anything.
 */
const INVALID_PATH_SEQUENCES = ['//', '/./', '/../', '%2f', '%2F'];
const INVALID_PATH_SUFFIXES = ['/..', '/.'];

const PATH_TYPE_EXACT = 'Exact';
const PATH_TYPE_PREFIX = 'Prefix';
const PATH_TYPE_IMPLEMENTATION_SPECIFIC = 'ImplementationSpecific';

/**
 * The checks the apiserver runs on an Ingress, from ValidateIngress in
 * pkg/apis/networking/validation. Like a Service, an Ingress describes no Pod,
 * so none of the shared PodSpec rules apply and everything checked beyond the
 * schema is here.
 *
 * What layer 1 already derives is deliberately absent: `pathType` and `backend`
 * are required on a path, `paths` on an `http` block and `name` on a service
 * backend, so only the cases the schema cannot express — an empty list, an
 * empty string, a pair of mutually exclusive fields — are checked below.
 *
 * The networking/v1 Ingress has been served unchanged since 1.19, so nothing
 * here needs a version gate: every field this module reads exists on all
 * supported releases.
 */
export const ingressRule: Rule = {
  id: 'ingress/spec',
  run(ctx: RuleContext) {
    checkClassAnnotation(ctx);

    // An absent spec still means "an Ingress that routes nothing", which is the
    // same rejection as an empty one. A spec of the wrong shape is layer 1's.
    const declared = ctx.doc['spec'];
    const spec = declared == null ? {} : asObject(declared);
    if (!spec) return;

    checkIngressClassName(ctx, spec);
    checkRouting(ctx, spec);
    checkTLS(ctx, spec);
  },
};

/* Ingress class */

function checkIngressClassName(ctx: RuleContext, spec: Record<string, unknown>): void {
  const className = asString(spec['ingressClassName']);
  if (className === undefined) return;

  const check = isDNS1123Subdomain(className);
  if (!check.ok) {
    ctx.report({
      ruleId: 'ingress/invalid-class-name',
      severity: 'error',
      path: ['spec', 'ingressClassName'],
      message: `"${className}" is not a valid ingressClassName: it ${check.reason}.`,
      explanation:
        'It names an IngressClass object, so it follows the ordinary object name rules: lowercase letters, digits, "-" and ".", starting and ending with an alphanumeric character. It is the name of the class, not of the controller behind it.',
      docsUrl: CLASS_DOCS,
    });
  }
}

/**
 * The annotation that predates IngressClass. The apiserver accepts it — it is
 * an annotation, so it accepts anything — but a controller implementing the
 * IngressClass API reads `spec.ingressClassName` instead, which is what makes a
 * manifest carrying only the annotation silently unclaimed.
 */
function checkClassAnnotation(ctx: RuleContext): void {
  const annotations = asObject(asObject(ctx.doc['metadata'])?.['annotations']);
  const legacy = annotations?.[LEGACY_CLASS_ANNOTATION];
  if (legacy === undefined) return;

  const className = asString(asObject(ctx.doc['spec'])?.['ingressClassName']);
  const value = asString(legacy);
  const path: Path = ['metadata', 'annotations', LEGACY_CLASS_ANNOTATION];

  ctx.report({
    ruleId: 'ingress/deprecated-class-annotation',
    severity: 'warning',
    path,
    anchor: 'key',
    message:
      className === undefined
        ? `The "${LEGACY_CLASS_ANNOTATION}" annotation is deprecated; use spec.ingressClassName.`
        : `The "${LEGACY_CLASS_ANNOTATION}" annotation is deprecated and disagrees with spec.ingressClassName: "${className}".`,
    explanation:
      'The annotation was never formally defined; IngressClass replaced it in 1.18 and it is what controllers written against the current API read. Which of the two wins when both are present is up to the controller, so the pair is worth resolving rather than leaving to it.',
    docsUrl: CLASS_DOCS,
    fix:
      className === undefined && value !== undefined
        ? {
            title: `Move it to spec.ingressClassName: ${value}`,
            safe: false,
            ops: [
              { op: 'set', path: ['spec', 'ingressClassName'], value },
              { op: 'delete', path },
            ],
          }
        : {
            title: 'Remove the annotation',
            safe: false,
            ops: [{ op: 'delete', path }],
          },
  });
}

/* Rules and backends */

function checkRouting(ctx: RuleContext, spec: Record<string, unknown>): void {
  const rules = asArray(spec['rules']);
  const defaultBackend = spec['defaultBackend'];

  if ((rules === undefined || rules.length === 0) && defaultBackend === undefined) {
    ctx.report({
      ruleId: 'ingress/no-routes',
      severity: 'error',
      path: rules === undefined ? ['spec'] : ['spec', 'rules'],
      ...(rules === undefined ? { anchor: 'key' as const } : {}),
      message: 'An Ingress must set either spec.defaultBackend or spec.rules.',
      explanation:
        'An Ingress is a routing table, and one with neither a rule nor a default backend routes nothing. The apiserver rejects it with "either `defaultBackend` or `rules` must be specified".',
      docsUrl: RULES_DOCS,
    });
  }

  if (defaultBackend !== undefined) {
    checkBackend(ctx, defaultBackend, ['spec', 'defaultBackend'], 'The default backend');
  }

  if (!rules) return;

  // (host, pathType, path) is what a request is matched against, so the same
  // triple twice means the second copy is unreachable.
  const seenPaths = new Map<string, string>();

  rules.forEach((entry, index) => {
    const rule = asObject(entry);
    if (!rule) return;
    const path: Path = ['spec', 'rules', index];
    const host = asString(rule['host']);

    if (host !== undefined && host !== '') checkHost(ctx, host, [...path, 'host'], 'rule');

    if (rule['http'] === undefined) {
      ctx.report({
        ruleId: 'ingress/rule-without-http',
        severity: 'warning',
        path,
        message: `Rule ${index + 1} has no "http" block, so it routes nothing.`,
        explanation:
          'HTTP is the only rule value the API defines: a rule names a host and then lists the paths under it. A rule with only a host matches requests and then has nowhere to send them, so the host falls through to the default backend as though the rule were not there.',
        docsUrl: RULES_DOCS,
      });
      return;
    }

    const http = asObject(rule['http']);
    if (!http) return;
    const paths = asArray(http['paths']);
    if (!paths) return;

    if (paths.length === 0) {
      ctx.report({
        ruleId: 'ingress/empty-paths',
        severity: 'error',
        path: [...path, 'http', 'paths'],
        message: `Rule ${index + 1} declares an empty path list.`,
        explanation:
          'A rule routes by path, so it needs at least one. The apiserver rejects an empty list with "Required value", exactly as it rejects a missing one.',
        docsUrl: RULES_DOCS,
      });
      return;
    }

    paths.forEach((pathEntry, pathIndex) => {
      checkPath(ctx, pathEntry, [...path, 'http', 'paths', pathIndex], index, pathIndex, host, seenPaths);
    });
  });
}

/**
 * A rule or TLS host. An Ingress routes by the Host header, so the value is a
 * name: an IP address is refused outright, and a "*" anywhere in the value
 * makes the whole thing a wildcard that has to be spelled "*.example.com".
 */
function checkHost(ctx: RuleContext, host: string, path: Path, where: 'rule' | 'tls'): void {
  if (where === 'rule' && isIPAddress(host).ok) {
    ctx.report({
      ruleId: 'ingress/host-is-ip',
      severity: 'error',
      path,
      message: `"${host}" is an IP address, but a rule host must be a DNS name.`,
      explanation:
        'The host is matched against the request\'s Host header, and the address the Ingress itself answers on is the load balancer\'s, not something a rule chooses. An Ingress that should answer on an address regardless of the name uses a rule with no host at all.',
      docsUrl: RULES_DOCS,
    });
    return;
  }

  if (host.includes('*')) {
    const check = isWildcardDNS1123Subdomain(host);
    if (!check.ok) {
      ctx.report({
        ruleId: 'ingress/invalid-wildcard-host',
        severity: 'error',
        path,
        message: `"${host}" is not a valid wildcard host: it ${check.reason}.`,
        explanation:
          'A "*" is only allowed as the whole leftmost label, and it stands for exactly one label: "*.example.com" matches "web.example.com" but neither "example.com" itself nor "a.web.example.com".',
        docsUrl: RULES_DOCS,
      });
    }
    return;
  }

  const check = isDNS1123Subdomain(host);
  if (!check.ok) {
    ctx.report({
      ruleId: 'ingress/invalid-host',
      severity: 'error',
      path,
      message: `"${host}" is not a valid host: it ${check.reason}.`,
      explanation:
        'A host is a hostname and nothing else: lowercase letters, digits, "-" and ".", starting and ending with an alphanumeric character. It carries no scheme, no port and no path — the port is implied by the Ingress, and the path belongs in the rule below.',
      docsUrl: RULES_DOCS,
    });
  }
}

function checkPath(
  ctx: RuleContext,
  entry: unknown,
  path: Path,
  ruleIndex: number,
  pathIndex: number,
  host: string | undefined,
  seenPaths: Map<string, string>,
): void {
  const item = asObject(entry);
  if (!item) return;

  // A missing pathType is layer 1's report and an unrecognised one is the enum
  // table's, so both leave the path itself alone: without knowing how it will
  // be matched there is nothing to say about it.
  const pathType = asString(item['pathType']);
  const value = asString(item['path']);
  const label = `rule ${ruleIndex + 1}, path ${pathIndex + 1}`;

  if (pathType === PATH_TYPE_EXACT || pathType === PATH_TYPE_PREFIX) {
    if (value === undefined || !value.startsWith('/')) {
      ctx.report({
        ruleId: 'ingress/path-not-absolute',
        severity: 'error',
        path: value === undefined ? path : [...path, 'path'],
        ...(value === undefined ? { anchor: 'key' as const } : {}),
        message:
          value === undefined
            ? `A "${pathType}" path must set "path".`
            : `"${value}" is not an absolute path; it must begin with "/".`,
        explanation: `Both "${PATH_TYPE_EXACT}" and "${PATH_TYPE_PREFIX}" match against the path of the incoming request, which always begins with "/". Only "${PATH_TYPE_IMPLEMENTATION_SPECIFIC}" may leave the path out, and then the controller decides what to do with the rule.`,
        docsUrl: PATH_TYPE_DOCS,
        fix:
          value !== undefined && value !== ''
            ? {
                title: `Change to "/${value}"`,
                safe: false,
                ops: [{ op: 'set', path: [...path, 'path'], value: `/${value}` }],
              }
            : undefined,
      });
    }
    if (value !== undefined && value !== '') {
      checkPathSequences(ctx, value, [...path, 'path']);
    }
  } else if (pathType === PATH_TYPE_IMPLEMENTATION_SPECIFIC) {
    if (value !== undefined && value !== '' && !value.startsWith('/')) {
      ctx.report({
        ruleId: 'ingress/path-not-absolute',
        severity: 'error',
        path: [...path, 'path'],
        message: `"${value}" is not an absolute path; it must begin with "/".`,
        explanation: `An "${PATH_TYPE_IMPLEMENTATION_SPECIFIC}" path may be left out entirely, but a path that is present is still a path and has to begin with "/". What the controller then makes of it is up to the controller.`,
        docsUrl: PATH_TYPE_DOCS,
        fix: {
          title: `Change to "/${value}"`,
          safe: false,
          ops: [{ op: 'set', path: [...path, 'path'], value: `/${value}` }],
        },
      });
    }
  }

  if (pathType !== undefined && value !== undefined) {
    const key = `${host ?? ''} ${pathType} ${value}`;
    const first = seenPaths.get(key);
    if (first === undefined) {
      seenPaths.set(key, label);
    } else {
      ctx.report({
        ruleId: 'ingress/duplicate-path',
        severity: 'warning',
        path: [...path, 'path'],
        message: `${host ? `Host "${host}" already routes` : 'This Ingress already routes'} "${value}" as ${pathType} in ${first}.`,
        explanation:
          'A request is matched against the host, the path type and the path, so an identical triple is a second entry that can never be reached. Which of the two a controller keeps is not defined; the apiserver accepts both.',
        docsUrl: PATH_TYPE_DOCS,
      });
    }
  }

  checkBackend(ctx, item['backend'], [...path, 'backend'], `The backend for ${label}`);
}

function checkPathSequences(ctx: RuleContext, value: string, path: Path): void {
  for (const sequence of INVALID_PATH_SEQUENCES) {
    if (!value.includes(sequence)) continue;
    ctx.report({
      ruleId: 'ingress/invalid-path-sequence',
      severity: 'error',
      path,
      message: `"${value}" must not contain "${sequence}".`,
      explanation:
        'A path is matched element by element after being split on "/", so an empty element, a "." or a ".." can never match a request — and an escaped slash ("%2f") would let a request reach a rule the path was written to exclude. The apiserver refuses all of them.',
      docsUrl: PATH_TYPE_DOCS,
    });
    return;
  }

  for (const suffix of INVALID_PATH_SUFFIXES) {
    if (!value.endsWith(suffix)) continue;
    ctx.report({
      ruleId: 'ingress/invalid-path-sequence',
      severity: 'error',
      path,
      message: `"${value}" must not end with "${suffix}".`,
      explanation:
        'A trailing "." or ".." is a relative element with nothing after it to resolve against, so it matches no request path. The apiserver refuses it.',
      docsUrl: PATH_TYPE_DOCS,
    });
    return;
  }
}

/**
 * A backend is exactly one of a Service reference or a resource reference, and
 * a Service reference names exactly one of a port number or a port name.
 */
function checkBackend(ctx: RuleContext, backend: unknown, path: Path, label: string): void {
  const value = asObject(backend);
  if (!value) return;

  const hasService = value['service'] !== undefined;
  const hasResource = value['resource'] !== undefined;

  if (hasService && hasResource) {
    ctx.report({
      ruleId: 'ingress/ambiguous-backend',
      severity: 'error',
      path,
      anchor: 'key',
      message: `${label} sets both "service" and "resource".`,
      explanation:
        'The two are alternatives: a service backend forwards to a Service in the same namespace, a resource backend hands the request to another object entirely — a storage bucket, say — through whatever the controller makes of it. The apiserver rejects a backend that names both.',
      docsUrl: BACKEND_DOCS,
    });
    return;
  }

  if (!hasService && !hasResource) {
    ctx.report({
      ruleId: 'ingress/empty-backend',
      severity: 'error',
      path,
      anchor: 'key',
      message: `${label} names neither a "service" nor a "resource".`,
      explanation:
        'A backend is where matched traffic goes, so it has to name something. The apiserver rejects an empty one with "resource or service backend is required".',
      docsUrl: BACKEND_DOCS,
    });
    return;
  }

  const service = asObject(value['service']);
  if (!service) return;

  const name = asString(service['name']);
  if (name === '') {
    ctx.report({
      ruleId: 'ingress/missing-backend-service-name',
      severity: 'error',
      path: [...path, 'service', 'name'],
      message: `${label} does not name a Service.`,
      explanation:
        'A service backend forwards to a Service by name, in the Ingress\'s own namespace. The apiserver rejects an empty name with "Required value".',
      docsUrl: BACKEND_DOCS,
    });
  } else if (name !== undefined) {
    const check = isDNS1035Label(name);
    if (!check.ok) {
      ctx.report({
        ruleId: 'ingress/invalid-backend-service-name',
        severity: 'error',
        path: [...path, 'service', 'name'],
        message: `"${name}" is not a valid Service name: it ${check.reason}.`,
        explanation:
          'The field carries a Service name, which is an RFC 1035 label rather than a subdomain: it must start with a letter and carry no dots. A Service in another namespace cannot be reached from here at all — the reference is namespace-local.',
        docsUrl: BACKEND_DOCS,
      });
    }
  }

  checkBackendPort(ctx, service, [...path, 'service'], label);
}

function checkBackendPort(
  ctx: RuleContext,
  service: Record<string, unknown>,
  path: Path,
  label: string,
): void {
  const port = asObject(service['port']);
  const name = port === undefined ? undefined : asString(port['name']);
  const number = port === undefined ? undefined : asNumber(port['number']);

  // The API's zero values are what "unset" looks like on the wire, so an empty
  // name and a port of 0 are both read as absent rather than as a choice.
  const hasName = name !== undefined && name !== '';
  const hasNumber = number !== undefined && number !== 0;

  if (hasName && hasNumber) {
    ctx.report({
      ruleId: 'ingress/ambiguous-backend-port',
      severity: 'error',
      path,
      anchor: 'key',
      message: `${label} sets both a port name and a port number.`,
      explanation:
        'The two are alternatives: a name is looked up among the Service\'s own port names, a number is matched against its `port` values. Naming both leaves the controller no way to tell which was meant, so the apiserver rejects it.',
      docsUrl: BACKEND_DOCS,
    });
    return;
  }

  if (name !== undefined && name !== '') {
    const check = isPortName(name);
    if (!check.ok) {
      ctx.report({
        ruleId: 'ingress/invalid-backend-port-name',
        severity: 'error',
        path: [...path, 'port', 'name'],
        message: `"${name}" is not a valid port name: it ${check.reason}.`,
        explanation:
          'It refers to a port of the target Service by name, so it follows the IANA service name rules those names use: at most 15 characters, lowercase letters, digits and "-", containing at least one letter, with no leading, trailing or repeated hyphens.',
        docsUrl: BACKEND_DOCS,
      });
    }
    return;
  }

  if (number !== undefined && number !== 0) {
    if (!Number.isInteger(number) || number < MIN_PORT || number > MAX_PORT) {
      ctx.report({
        ruleId: 'ingress/backend-port-out-of-range',
        severity: 'error',
        path: [...path, 'port', 'number'],
        message: `Port ${number} is out of range; it must be between ${MIN_PORT} and ${MAX_PORT}.`,
        explanation: 'TCP port numbers are 16-bit, and 0 is not assignable.',
        docsUrl: BACKEND_DOCS,
      });
    }
    return;
  }

  ctx.report({
    ruleId: 'ingress/missing-backend-port',
    severity: 'error',
    path: port === undefined ? path : [...path, 'port'],
    anchor: 'key',
    message: `${label} does not name a port on the Service.`,
    explanation:
      'A Service can expose several ports, so a backend has to say which one it means — either "number", matched against the Service\'s `port` values, or "name", matched against its port names. The apiserver rejects a service backend with neither.',
    docsUrl: BACKEND_DOCS,
  });
}

/* TLS */

function checkTLS(ctx: RuleContext, spec: Record<string, unknown>): void {
  const tls = asArray(spec['tls']);
  if (!tls) return;

  const ruleHosts = asArray(spec['rules'])
    ?.map((entry) => asString(asObject(entry)?.['host']))
    .filter((host): host is string => host !== undefined && host !== '');

  tls.forEach((entry, index) => {
    const item = asObject(entry);
    if (!item) return;
    const path: Path = ['spec', 'tls', index];

    asArray(item['hosts'])?.forEach((value, hostIndex) => {
      const host = asString(value);
      if (host === undefined || host === '') return;
      const hostPath: Path = [...path, 'hosts', hostIndex];

      checkHost(ctx, host, hostPath, 'tls');

      // Only worth saying when the Ingress does route by host: with no
      // host-bearing rule at all, a certificate served for a name the rules do
      // not mention is how a default-backend Ingress is normally written.
      if (ruleHosts && ruleHosts.length > 0 && !ruleHosts.some((rule) => hostMatches(rule, host))) {
        ctx.report({
          ruleId: 'ingress/tls-host-unmatched',
          severity: 'warning',
          path: hostPath,
          message: `No rule routes "${host}", so the certificate for it is never presented.`,
          explanation:
            'The TLS block says which certificate terminates which name; the rules say what is served under it. A name in one and not the other means the certificate is loaded and then never selected, which is what a request arriving on that name and getting the controller\'s default certificate looks like.',
          docsUrl: TLS_DOCS,
        });
      }
    });

    const secretName = asString(item['secretName']);
    if (secretName === undefined || secretName === '') return;
    const check = isDNS1123Subdomain(secretName);
    if (!check.ok) {
      ctx.report({
        ruleId: 'ingress/invalid-secret-name',
        severity: 'error',
        path: [...path, 'secretName'],
        message: `"${secretName}" is not a valid secret name: it ${check.reason}.`,
        explanation:
          'It names a Secret of type kubernetes.io/tls in the Ingress\'s own namespace, so it follows the ordinary object name rules: lowercase letters, digits, "-" and ".", starting and ending with an alphanumeric character.',
        docsUrl: TLS_DOCS,
      });
    }
  });
}

/** Do a rule host and a TLS host name the same thing, wildcards included? */
function hostMatches(a: string, b: string): boolean {
  return a === b || covers(a, b) || covers(b, a);
}

function covers(pattern: string, host: string): boolean {
  if (!pattern.startsWith('*.')) return false;
  const suffix = pattern.slice(1);
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, host.length - suffix.length);
  return label.length > 0 && !label.includes('.');
}
