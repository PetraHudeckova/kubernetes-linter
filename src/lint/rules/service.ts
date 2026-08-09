import { isCIDR, isIPAddress, isSpecialIP } from '../../k8s/net.js';
import {
  DNS_1123_LABEL_MAX,
  isDNS1123Label,
  isDNS1123Subdomain,
  isPortName,
  isQualifiedName,
} from '../../k8s/names.js';
import { asArray, asNumber, asObject, asString, type Rule, type RuleContext } from './context.js';
import { checkKeyedMap } from './metadata.js';

const SERVICE_DOCS = 'https://kubernetes.io/docs/concepts/services-networking/service/';
const TYPE_DOCS = `${SERVICE_DOCS}#publishing-services-service-types`;
const DUAL_STACK_DOCS = 'https://kubernetes.io/docs/concepts/services-networking/dual-stack/';

const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * The default `--service-node-port-range`. The apiserver checks node ports
 * against whatever range it was started with, so a number outside this one is
 * only a warning: it is rejected on a default cluster and fine on a cluster
 * configured to allow it.
 */
const DEFAULT_NODE_PORT_RANGE = [30000, 32767] as const;

/** ClientIPConfig.timeoutSeconds, capped at a day by MaxClientIPServiceAffinitySeconds. */
const MAX_AFFINITY_SECONDS = 86400;

const TYPE_CLUSTER_IP = 'ClusterIP';
const TYPE_NODE_PORT = 'NodePort';
const TYPE_LOAD_BALANCER = 'LoadBalancer';
const TYPE_EXTERNAL_NAME = 'ExternalName';
const HEADLESS = 'None';

/**
 * The checks the apiserver runs on a Service, from ValidateService in
 * pkg/apis/core/validation. A Service is the one kind here with no pod template
 * at all, so none of the shared PodSpec rules apply to it: everything it is
 * checked for beyond the schema is in this module.
 *
 * Most of what makes a Service invalid is a field that contradicts its `type`.
 * `type` decides which of the others are allowed to exist, so it is read once
 * and threaded through as the effective type — or as undefined when the value
 * is not one the API knows, which the enum table has already reported. The
 * checks that turn on the type sit out that case rather than guess at what was
 * meant; the ones that do not, from port numbers to IP formats, still run.
 *
 * Every ServiceSpec field this module touches has existed since 1.25, so there
 * is nothing here to version-gate — the only later arrival, trafficDistribution
 * (1.30), is covered by the enum table, which gates itself through the schema.
 */
export const serviceRule: Rule = {
  id: 'service/spec',
  run(ctx: RuleContext) {
    // ServiceSpec is optional in the schema but not in practice: an absent or
    // empty one still defaults to a ClusterIP Service, which needs a port. A
    // spec of the wrong shape is layer 1's to report, not this module's.
    const declared = ctx.doc['spec'];
    const spec = declared == null ? {} : asObject(declared);
    if (!spec) return;

    const declaredType = asString(spec['type']);
    const known = [TYPE_CLUSTER_IP, TYPE_NODE_PORT, TYPE_LOAD_BALANCER, TYPE_EXTERNAL_NAME];
    const type =
      declaredType === undefined
        ? TYPE_CLUSTER_IP
        : known.includes(declaredType)
          ? declaredType
          : undefined;

    checkPorts(ctx, spec, type);
    checkSelector(ctx, spec, type);
    checkClusterIP(ctx, spec, type);
    checkExternalName(ctx, spec, type);
    checkExternalIPs(ctx, spec);
    checkTrafficPolicies(ctx, spec, type);
    checkLoadBalancer(ctx, spec, type);
    checkSessionAffinity(ctx, spec);
    checkIPFamilies(ctx, spec, type);
  },
};

/* Ports */

function checkPorts(ctx: RuleContext, spec: Record<string, unknown>, type?: string): void {
  const ports = asArray(spec['ports']);
  const headless = asString(spec['clusterIP']) === HEADLESS;

  // A headless Service publishes its endpoints through DNS rather than through
  // a virtual IP, so it is the one shape that needs no ports at all; an
  // ExternalName is only a CNAME, so it needs none either.
  if (
    (ports === undefined || ports.length === 0) &&
    type !== undefined &&
    type !== TYPE_EXTERNAL_NAME &&
    !headless
  ) {
    ctx.report({
      ruleId: 'service/missing-ports',
      severity: 'error',
      path: ports === undefined ? ['spec'] : ['spec', 'ports'],
      ...(ports === undefined ? { anchor: 'key' as const } : {}),
      message: `A ${type} Service must expose at least one port.`,
      explanation:
        'The port list is what the Service proxies: without it there is nothing to route to the Pods the selector matches, and the apiserver rejects the object with "Required value". Only a headless Service (clusterIP: None) or an ExternalName may leave it out.',
      docsUrl: SERVICE_DOCS,
    });
    return;
  }
  if (!ports) return;

  const named = new Map<string, number>();
  const nodePorts = new Map<string, number>();
  const numbers = new Map<string, number>();

  ports.forEach((entry, index) => {
    const port = asObject(entry);
    if (!port) return;
    const path = ['spec', 'ports', index];
    const protocol = asString(port['protocol']) ?? 'TCP';

    checkPortName(ctx, port, path, ports.length > 1, named, index);

    const number = asNumber(port['port']);
    if (number !== undefined) {
      checkPortRange(ctx, [...path, 'port'], 'port', number);

      // Layer 1 already reports a duplicate through the list-map keys on
      // ServiceSpec.ports — but only when both entries spell out a protocol,
      // since an entry missing one of the keys has no identity to compare.
      // That leaves the commonest form of the mistake, two entries that both
      // default to TCP, to be caught here.
      const key = `${protocol}/${number}`;
      const first = numbers.get(key);
      if (first === undefined) {
        numbers.set(key, index);
      } else if (port['protocol'] === undefined || asObject(ports[first])?.['protocol'] === undefined) {
        ctx.report({
          ruleId: 'service/duplicate-port',
          severity: 'error',
          path: [...path, 'port'],
          message: `Port ${number}/${protocol} is already exposed by entry ${first + 1}.`,
          explanation:
            'A Service routes each port and protocol pair to exactly one target, so the pair has to be unique. Protocol defaults to TCP, which is what makes two entries that name neither a duplicate of each other.',
          docsUrl: SERVICE_DOCS,
        });
      }
    }

    checkTargetPort(ctx, port['targetPort'], [...path, 'targetPort']);
    checkNodePort(ctx, port, path, type, protocol, nodePorts, index);

    const appProtocol = asString(port['appProtocol']);
    if (appProtocol !== undefined) {
      const check = isQualifiedName(appProtocol);
      if (!check.ok) {
        ctx.report({
          ruleId: 'service/invalid-app-protocol',
          severity: 'error',
          path: [...path, 'appProtocol'],
          message: `"${appProtocol}" is not a valid appProtocol: it ${check.reason}.`,
          explanation:
            'appProtocol follows label syntax: either a bare IANA service name such as "http", or a prefixed name such as "kubernetes.io/h2c" or "example.com/my-protocol".',
          docsUrl: SERVICE_DOCS,
        });
      }
    }
  });
}

function checkPortName(
  ctx: RuleContext,
  port: Record<string, unknown>,
  path: (string | number)[],
  requireName: boolean,
  named: Map<string, number>,
  index: number,
): void {
  const name = asString(port['name']);

  if (name === undefined || name === '') {
    if (!requireName) return;
    ctx.report({
      ruleId: 'service/unnamed-port',
      severity: 'error',
      path: name === undefined ? path : [...path, 'name'],
      message: 'Every port needs a name once a Service exposes more than one.',
      explanation:
        'The name is how an EndpointSlice, an Ingress backend or another Service consumer picks this port out of the list, so it may only be omitted when there is nothing to pick between. The apiserver rejects the unnamed entry with "Required value".',
      docsUrl: SERVICE_DOCS,
    });
    return;
  }

  const check = isDNS1123Label(name);
  if (!check.ok) {
    ctx.report({
      ruleId: 'service/invalid-port-name',
      severity: 'error',
      path: [...path, 'name'],
      message: `"${name}" is not a valid port name: it ${check.reason}.`,
      explanation: `A Service port name is a DNS label: lowercase letters, digits and "-", at most ${DNS_1123_LABEL_MAX} characters, starting and ending with an alphanumeric character.`,
      docsUrl: SERVICE_DOCS,
    });
  }

  const first = named.get(name);
  if (first !== undefined) {
    ctx.report({
      ruleId: 'service/duplicate-port-name',
      severity: 'error',
      path: [...path, 'name'],
      message: `Port name "${name}" is already used by entry ${first + 1}.`,
      explanation:
        'Port names identify a port within the Service, so they must be unique across its port list.',
      docsUrl: SERVICE_DOCS,
    });
  } else {
    named.set(name, index);
  }
}

/**
 * targetPort is an IntOrString: a port number on the Pod, or the name of a
 * container port. The name form follows the container port rules rather than
 * the Service port ones — it has to match a `ports[].name` in the pod spec,
 * and those are IANA service names.
 */
function checkTargetPort(ctx: RuleContext, value: unknown, path: (string | number)[]): void {
  if (typeof value === 'number') {
    checkPortRange(ctx, path, 'targetPort', value);
    return;
  }

  const name = asString(value);
  if (name === undefined) return;

  // A number in quotes is not a name — the apiserver reads an IntOrString
  // string as a name and nothing else, so "8080" never resolves to a port.
  if (/^\d+$/.test(name)) {
    const number = Number(name);
    ctx.report({
      ruleId: 'service/quoted-target-port',
      severity: 'error',
      path,
      message: `targetPort "${name}" is a string, so it names a container port rather than the number ${number}.`,
      explanation:
        'An int-or-string field distinguishes the two by their YAML type. Quoted, this is looked up among the pod\'s container port names, where a name made only of digits cannot exist — port names must contain at least one letter.',
      docsUrl: SERVICE_DOCS,
      fix: {
        title: `Change to the number ${number}`,
        safe: true,
        ops: [{ op: 'set', path, value: number }],
      },
    });
    return;
  }

  const check = isPortName(name);
  if (!check.ok) {
    ctx.report({
      ruleId: 'service/invalid-target-port',
      severity: 'error',
      path,
      message: `"${name}" is not a valid targetPort: it ${check.reason}.`,
      explanation:
        'A named targetPort refers to a container port by name, so it follows the IANA service name rules those names use: at most 15 characters, lowercase letters, digits and "-", containing at least one letter, with no leading, trailing or repeated hyphens.',
      docsUrl: SERVICE_DOCS,
    });
  }
}

function checkNodePort(
  ctx: RuleContext,
  port: Record<string, unknown>,
  path: (string | number)[],
  type: string | undefined,
  protocol: string,
  seen: Map<string, number>,
  index: number,
): void {
  const nodePort = asNumber(port['nodePort']);
  if (nodePort === undefined) return;

  if (type !== undefined && type !== TYPE_NODE_PORT && type !== TYPE_LOAD_BALANCER) {
    ctx.report({
      ruleId: 'service/node-port-not-allowed',
      severity: 'error',
      path: [...path, 'nodePort'],
      message: `nodePort may not be used when type is "${type}".`,
      explanation:
        'A node port is a port opened on every node in the cluster, which only the NodePort and LoadBalancer types ask for. The apiserver rejects it on any other type rather than silently ignoring it.',
      docsUrl: TYPE_DOCS,
      fix: {
        title: 'Set type: NodePort',
        safe: false,
        ops: [{ op: 'set', path: ['spec', 'type'], value: TYPE_NODE_PORT }],
      },
    });
    return;
  }

  checkPortRange(ctx, [...path, 'nodePort'], 'nodePort', nodePort);

  const [low, high] = DEFAULT_NODE_PORT_RANGE;
  if (nodePort >= MIN_PORT && nodePort <= MAX_PORT && (nodePort < low || nodePort > high)) {
    ctx.report({
      ruleId: 'service/node-port-outside-default-range',
      severity: 'warning',
      path: [...path, 'nodePort'],
      message: `nodePort ${nodePort} is outside the default node port range ${low}-${high}.`,
      explanation:
        'The apiserver only allocates node ports from its --service-node-port-range, which defaults to 30000-32767. On a cluster left at that default this is rejected with "provided port is not in the valid range"; on one started with a wider range it is fine.',
      docsUrl: TYPE_DOCS,
    });
  }

  const key = `${protocol}/${nodePort}`;
  const first = seen.get(key);
  if (first === undefined) {
    seen.set(key, index);
  } else {
    ctx.report({
      ruleId: 'service/duplicate-node-port',
      severity: 'error',
      path: [...path, 'nodePort'],
      message: `Node port ${nodePort}/${protocol} is already claimed by entry ${first + 1}.`,
      explanation:
        'A node port is a real socket on every node, so two ports of the same Service cannot ask for the same number and protocol.',
      docsUrl: TYPE_DOCS,
    });
  }
}

function checkPortRange(
  ctx: RuleContext,
  path: (string | number)[],
  field: string,
  value: number,
): void {
  if (!Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) {
    ctx.report({
      ruleId: 'service/port-out-of-range',
      severity: 'error',
      path,
      message: `${field} ${value} is out of range; it must be between ${MIN_PORT} and ${MAX_PORT}.`,
      explanation: 'TCP and UDP port numbers are 16-bit, and 0 is not assignable.',
    });
  }
}

/* Selector */

function checkSelector(ctx: RuleContext, spec: Record<string, unknown>, type?: string): void {
  const selector = asObject(spec['selector']);

  // A Service selector is a plain map of equality requirements, not a
  // LabelSelector — there are no matchLabels and no set-based operators.
  checkKeyedMap(ctx, spec['selector'], ['spec', 'selector'], 'label', true);

  if (type === TYPE_EXTERNAL_NAME && selector && Object.keys(selector).length > 0) {
    ctx.report({
      ruleId: 'service/selector-ignored',
      severity: 'warning',
      path: ['spec', 'selector'],
      anchor: 'key',
      message: 'selector has no effect on an ExternalName Service.',
      explanation:
        'An ExternalName Service is resolved to a CNAME and never proxies traffic, so no endpoints are ever collected for it. The apiserver accepts the field and ignores it, which is why a type left over from an earlier edit is easy to miss.',
      docsUrl: TYPE_DOCS,
    });
  }
}

/* Cluster IP */

function checkClusterIP(ctx: RuleContext, spec: Record<string, unknown>, type?: string): void {
  const clusterIP = asString(spec['clusterIP']);
  const clusterIPs = asArray(spec['clusterIPs']);

  const check = (value: string, path: (string | number)[]): void => {
    if (value === '' || value === HEADLESS) return;
    const parsed = isIPAddress(value);
    if (parsed.ok) return;
    ctx.report({
      ruleId: 'service/invalid-cluster-ip',
      severity: 'error',
      path,
      message: `"${value}" is not a valid cluster IP: it ${parsed.reason}.`,
      explanation:
        'The field takes an IP address from the cluster\'s service CIDR, an empty string to have one allocated, or "None" for a headless Service.',
      docsUrl: SERVICE_DOCS,
    });
  };

  if (clusterIP !== undefined) check(clusterIP, ['spec', 'clusterIP']);
  clusterIPs?.forEach((entry, index) => {
    const value = asString(entry);
    if (value !== undefined) check(value, ['spec', 'clusterIPs', index]);
  });

  const first = clusterIPs === undefined ? undefined : asString(clusterIPs[0]);
  if (clusterIP !== undefined && clusterIP !== '' && first !== undefined && first !== clusterIP) {
    ctx.report({
      ruleId: 'service/cluster-ip-mismatch',
      severity: 'error',
      path: ['spec', 'clusterIP'],
      message: `clusterIP "${clusterIP}" must match the first entry of clusterIPs ("${first}").`,
      explanation:
        'clusterIPs is the dual-stack form of the same setting and clusterIP is its first entry, kept for clients that predate dual-stack. The apiserver rejects the two disagreeing rather than picking one.',
      docsUrl: DUAL_STACK_DOCS,
      fix: {
        title: `Change clusterIP to "${first}"`,
        safe: false,
        ops: [{ op: 'set', path: ['spec', 'clusterIP'], value: first }],
      },
    });
  }

  if (clusterIP === HEADLESS && (type === TYPE_NODE_PORT || type === TYPE_LOAD_BALANCER)) {
    ctx.report({
      ruleId: 'service/headless-with-external-type',
      severity: 'error',
      path: ['spec', 'clusterIP'],
      message: `clusterIP: None cannot be combined with type: ${type}.`,
      explanation:
        'Both NodePort and LoadBalancer are built on top of a cluster IP: they forward an externally reachable port to it. "None" removes that virtual IP, leaving nothing for the node port or the load balancer to forward to, so the apiserver rejects the pair.',
      docsUrl: TYPE_DOCS,
    });
  }
}

/* ExternalName */

function checkExternalName(ctx: RuleContext, spec: Record<string, unknown>, type?: string): void {
  // Everything here is a statement about the type, so an unusable one means
  // there is nothing to say.
  if (type === undefined) return;
  const externalName = asString(spec['externalName']);

  if (type !== TYPE_EXTERNAL_NAME) {
    if (externalName !== undefined) {
      ctx.report({
        ruleId: 'service/external-name-ignored',
        severity: 'warning',
        path: ['spec', 'externalName'],
        anchor: 'key',
        message: `externalName has no effect when type is "${type}".`,
        explanation:
          'The field is only read for an ExternalName Service, where it becomes the CNAME target. Under any other type the Service still proxies to its own endpoints and this value is ignored.',
        docsUrl: TYPE_DOCS,
        fix: {
          title: `Set type: ${TYPE_EXTERNAL_NAME}`,
          safe: false,
          ops: [{ op: 'set', path: ['spec', 'type'], value: TYPE_EXTERNAL_NAME }],
        },
      });
    }
    return;
  }

  if (externalName === undefined || externalName === '') {
    ctx.report({
      ruleId: 'service/missing-external-name',
      severity: 'error',
      path: externalName === undefined ? ['spec'] : ['spec', 'externalName'],
      ...(externalName === undefined ? { anchor: 'key' as const } : {}),
      message: 'An ExternalName Service must set spec.externalName.',
      explanation:
        'The whole Service is an alias: cluster DNS answers it with a CNAME pointing at this name. Without one there is nothing to alias, and the apiserver rejects the object with "Required value".',
      docsUrl: `${SERVICE_DOCS}#externalname`,
    });
  } else {
    // A fully qualified name may carry a trailing dot, which the apiserver
    // strips before validating the rest.
    const check = isDNS1123Subdomain(externalName.replace(/\.$/, ''));
    if (!check.ok) {
      ctx.report({
        ruleId: 'service/invalid-external-name',
        severity: 'error',
        path: ['spec', 'externalName'],
        message: `"${externalName}" is not a valid externalName: it ${check.reason}.`,
        explanation:
          'externalName becomes the target of a CNAME record, so it must be a hostname: lowercase letters, digits, "-" and ".", starting and ending with an alphanumeric character. It is a name, never an IP address — an IP here produces a CNAME that resolves to nothing.',
        docsUrl: `${SERVICE_DOCS}#externalname`,
      });
    }
  }

  const clusterIP = asString(spec['clusterIP']);
  const hasClusterIP = clusterIP !== undefined && clusterIP !== '';
  const hasClusterIPs = (asArray(spec['clusterIPs'])?.length ?? 0) > 0;

  for (const field of ['clusterIP', 'clusterIPs'] as const) {
    if (field === 'clusterIP' ? !hasClusterIP : !hasClusterIPs) continue;
    ctx.report({
      ruleId: 'service/external-name-with-cluster-ip',
      severity: 'error',
      path: ['spec', field],
      message: `${field} must be empty for an ExternalName Service.`,
      explanation:
        'An ExternalName Service is a DNS alias and nothing else: no virtual IP is allocated for it and no proxying happens, so the apiserver rejects a cluster IP here — including "None", which would still be a statement about a virtual IP it does not have.',
      docsUrl: `${SERVICE_DOCS}#externalname`,
      fix: {
        title: `Remove ${field}`,
        safe: false,
        ops: [{ op: 'delete', path: ['spec', field] }],
      },
    });
  }
}

/* External IPs */

function checkExternalIPs(ctx: RuleContext, spec: Record<string, unknown>): void {
  asArray(spec['externalIPs'])?.forEach((entry, index) => {
    const value = asString(entry);
    if (value === undefined) return;
    const path = ['spec', 'externalIPs', index];

    const parsed = isIPAddress(value);
    if (!parsed.ok) {
      ctx.report({
        ruleId: 'service/invalid-external-ip',
        severity: 'error',
        path,
        message: `"${value}" is not a valid IP address: it ${parsed.reason}.`,
        explanation:
          'externalIPs lists addresses that already route to a node in the cluster; Kubernetes does not manage them, it only accepts traffic addressed to them.',
        docsUrl: `${SERVICE_DOCS}#external-ips`,
      });
      return;
    }

    const special = isSpecialIP(value);
    if (special) {
      ctx.report({
        ruleId: 'service/special-external-ip',
        severity: 'error',
        path,
        message: `"${value}" cannot be used as an external IP: it ${special}.`,
        explanation:
          'An external IP has to be an address a client outside the node can send traffic to. The apiserver refuses the unspecified, loopback, link-local and link-local multicast ranges, since none of them are reachable from anywhere else.',
        docsUrl: `${SERVICE_DOCS}#external-ips`,
      });
    }
  });
}

/* Traffic policies */

function checkTrafficPolicies(ctx: RuleContext, spec: Record<string, unknown>, type?: string): void {
  if (type === undefined) return;
  const external = asString(spec['externalTrafficPolicy']);
  // "Externally accessible" is what the field turns on, and a ClusterIP Service
  // becomes that as soon as it claims an external IP — the policy is allowed
  // there too, not only on the two external types.
  const externallyAccessible =
    type === TYPE_NODE_PORT ||
    type === TYPE_LOAD_BALANCER ||
    (asArray(spec['externalIPs'])?.length ?? 0) > 0;

  if (external !== undefined && !externallyAccessible) {
    ctx.report({
      ruleId: 'service/external-traffic-policy-not-allowed',
      severity: 'error',
      path: ['spec', 'externalTrafficPolicy'],
      anchor: 'key',
      message: `externalTrafficPolicy may not be set when type is "${type}" and no externalIPs are claimed.`,
      explanation:
        'It describes how a node treats traffic arriving on one of the Service\'s externally-facing addresses — a node port, a load balancer address or an entry in externalIPs. A Service with none of those has no such traffic to describe; for traffic arriving on the cluster IP the equivalent setting is internalTrafficPolicy.',
      docsUrl: TYPE_DOCS,
      fix: {
        title: 'Remove externalTrafficPolicy',
        safe: false,
        ops: [{ op: 'delete', path: ['spec', 'externalTrafficPolicy'] }],
      },
    });
  }

  if (spec['internalTrafficPolicy'] !== undefined && type === TYPE_EXTERNAL_NAME) {
    ctx.report({
      ruleId: 'service/internal-traffic-policy-not-allowed',
      severity: 'error',
      path: ['spec', 'internalTrafficPolicy'],
      anchor: 'key',
      message: 'internalTrafficPolicy may not be set on an ExternalName Service.',
      explanation:
        'It routes traffic that arrives on the cluster IP, and an ExternalName Service has none — it is resolved by DNS and never proxied.',
      docsUrl: TYPE_DOCS,
      fix: {
        title: 'Remove internalTrafficPolicy',
        safe: false,
        ops: [{ op: 'delete', path: ['spec', 'internalTrafficPolicy'] }],
      },
    });
  }

  const healthCheckNodePort = asNumber(spec['healthCheckNodePort']);
  if (healthCheckNodePort === undefined) return;

  if (type !== TYPE_LOAD_BALANCER || external !== 'Local') {
    ctx.report({
      ruleId: 'service/health-check-node-port-not-allowed',
      severity: 'error',
      path: ['spec', 'healthCheckNodePort'],
      message:
        'healthCheckNodePort may only be set when type is "LoadBalancer" and externalTrafficPolicy is "Local".',
      explanation:
        'The port exists so an external load balancer can ask a node whether it has endpoints of its own — a question only "Local" makes meaningful, since under "Cluster" every node forwards to every endpoint. The apiserver rejects it on any other combination.',
      docsUrl: TYPE_DOCS,
    });
    return;
  }
  checkPortRange(ctx, ['spec', 'healthCheckNodePort'], 'healthCheckNodePort', healthCheckNodePort);
}

/* Load balancer */

function checkLoadBalancer(ctx: RuleContext, spec: Record<string, unknown>, type?: string): void {
  if (type !== undefined && type !== TYPE_LOAD_BALANCER) {
    for (const field of [
      'loadBalancerSourceRanges',
      'loadBalancerClass',
      'allocateLoadBalancerNodePorts',
      'loadBalancerIP',
    ]) {
      if (spec[field] === undefined) continue;
      ctx.report({
        ruleId: 'service/load-balancer-field-not-allowed',
        severity: 'error',
        path: ['spec', field],
        anchor: 'key',
        message: `${field} may only be used when type is "LoadBalancer", not "${type}".`,
        explanation:
          'The field configures the external load balancer that a LoadBalancer Service asks its cloud provider for. With no load balancer to configure the apiserver rejects it rather than ignore it.',
        docsUrl: TYPE_DOCS,
        fix: {
          title: `Set type: ${TYPE_LOAD_BALANCER}`,
          safe: false,
          ops: [{ op: 'set', path: ['spec', 'type'], value: TYPE_LOAD_BALANCER }],
        },
      });
    }
    return;
  }

  asArray(spec['loadBalancerSourceRanges'])?.forEach((entry, index) => {
    const value = asString(entry);
    if (value === undefined) return;
    // Leading and trailing spaces are tolerated: the field was once an
    // annotation holding a comma-separated list, and the apiserver still trims.
    const check = isCIDR(value.trim());
    if (check.ok) return;
    ctx.report({
      ruleId: 'service/invalid-source-range',
      severity: 'error',
      path: ['spec', 'loadBalancerSourceRanges', index],
      message: `"${value}" is not a valid CIDR block: it ${check.reason}.`,
      explanation:
        'Each entry restricts which client addresses the load balancer accepts, so each is a network rather than a single address — a bare "203.0.113.4" has to be written "203.0.113.4/32".',
      docsUrl:
        'https://kubernetes.io/docs/tasks/access-application-cluster/create-external-load-balancer/',
    });
  });

  const loadBalancerIP = asString(spec['loadBalancerIP']);
  if (loadBalancerIP !== undefined && !isIPAddress(loadBalancerIP).ok) {
    ctx.report({
      ruleId: 'service/invalid-load-balancer-ip',
      severity: 'error',
      path: ['spec', 'loadBalancerIP'],
      message: `"${loadBalancerIP}" is not a valid IP address: it ${isIPAddress(loadBalancerIP).reason}.`,
      explanation:
        'loadBalancerIP asks the cloud provider for a particular address for the load balancer. It is deprecated because its meaning varies between providers; where one is needed, a provider-specific annotation is the portable spelling.',
      docsUrl: TYPE_DOCS,
    });
  }

  const loadBalancerClass = asString(spec['loadBalancerClass']);
  if (loadBalancerClass !== undefined) {
    const check = isQualifiedName(loadBalancerClass);
    if (!check.ok) {
      ctx.report({
        ruleId: 'service/invalid-load-balancer-class',
        severity: 'error',
        path: ['spec', 'loadBalancerClass'],
        message: `"${loadBalancerClass}" is not a valid loadBalancerClass: it ${check.reason}.`,
        explanation:
          'The class names the implementation that should handle this Service, as a label-style identifier with an optional prefix — "example.com/internal-vip". Unprefixed names are reserved for the cluster\'s own use.',
        docsUrl: TYPE_DOCS,
      });
    }
  }
}

/* Session affinity */

function checkSessionAffinity(ctx: RuleContext, spec: Record<string, unknown>): void {
  const affinity = asString(spec['sessionAffinity']) ?? 'None';
  const config = asObject(spec['sessionAffinityConfig']);
  if (!config) return;

  if (affinity !== 'ClientIP') {
    ctx.report({
      ruleId: 'service/session-affinity-config-not-allowed',
      severity: 'error',
      path: ['spec', 'sessionAffinityConfig'],
      anchor: 'key',
      message: `sessionAffinityConfig may not be set when sessionAffinity is "${affinity}".`,
      explanation:
        'The block only configures client-IP affinity, so the apiserver rejects it unless sessionAffinity asks for that. Without sessionAffinity: ClientIP each connection is load-balanced independently.',
      docsUrl: `${SERVICE_DOCS}#session-stickiness-timeout`,
      fix: {
        title: 'Set sessionAffinity: ClientIP',
        safe: false,
        ops: [{ op: 'set', path: ['spec', 'sessionAffinity'], value: 'ClientIP' }],
      },
    });
    return;
  }

  const timeout = asNumber(asObject(config['clientIP'])?.['timeoutSeconds']);
  if (timeout !== undefined && (timeout <= 0 || timeout > MAX_AFFINITY_SECONDS)) {
    ctx.report({
      ruleId: 'service/invalid-affinity-timeout',
      severity: 'error',
      path: ['spec', 'sessionAffinityConfig', 'clientIP', 'timeoutSeconds'],
      message: `timeoutSeconds must be between 1 and ${MAX_AFFINITY_SECONDS}, but is ${timeout}.`,
      explanation:
        'It is how long a client keeps being sent to the same Pod after its last connection. The cap is one day; the default when unset is 10800 (three hours).',
      docsUrl: `${SERVICE_DOCS}#session-stickiness-timeout`,
    });
  }
}

/* Dual stack */

function checkIPFamilies(ctx: RuleContext, spec: Record<string, unknown>, type?: string): void {
  const families = asArray(spec['ipFamilies']);
  const policy = asString(spec['ipFamilyPolicy']);

  if (families) {
    if (families.length > 2) {
      ctx.report({
        ruleId: 'service/too-many-ip-families',
        severity: 'error',
        path: ['spec', 'ipFamilies'],
        message: `ipFamilies may list at most 2 entries, but lists ${families.length}.`,
        explanation: 'There are two IP families to choose from, IPv4 and IPv6.',
        docsUrl: DUAL_STACK_DOCS,
      });
    }

    const seen = new Map<string, number>();
    families.forEach((entry, index) => {
      const value = asString(entry);
      if (value === undefined) return;
      const path = ['spec', 'ipFamilies', index];

      if (value !== 'IPv4' && value !== 'IPv6') {
        ctx.report({
          ruleId: 'service/invalid-ip-family',
          severity: 'error',
          path,
          message: `"${value}" is not a valid IP family.`,
          explanation: 'Allowed values are "IPv4" and "IPv6". Values are case-sensitive.',
          docsUrl: DUAL_STACK_DOCS,
          fix:
            value.toLowerCase() === 'ipv4' || value.toLowerCase() === 'ipv6'
              ? {
                  title: `Change to "${value.toLowerCase() === 'ipv4' ? 'IPv4' : 'IPv6'}"`,
                  safe: true,
                  ops: [
                    {
                      op: 'set',
                      path,
                      value: value.toLowerCase() === 'ipv4' ? 'IPv4' : 'IPv6',
                    },
                  ],
                }
              : undefined,
        });
        return;
      }

      const first = seen.get(value);
      if (first === undefined) {
        seen.set(value, index);
      } else {
        ctx.report({
          ruleId: 'service/duplicate-ip-family',
          severity: 'error',
          path,
          message: `IP family "${value}" is already listed as entry ${first + 1}.`,
          explanation:
            'The list is ordered — the first entry is the family of the primary cluster IP — so naming one twice says nothing about the second.',
          docsUrl: DUAL_STACK_DOCS,
        });
      }
    });

    if (policy === 'SingleStack' && families.length > 1) {
      ctx.report({
        ruleId: 'service/ip-family-policy-conflict',
        severity: 'error',
        path: ['spec', 'ipFamilyPolicy'],
        message: `ipFamilyPolicy: SingleStack allows only one entry in ipFamilies, but ${families.length} are listed.`,
        explanation:
          'The policy is what decides how many families the Service gets: SingleStack takes one, PreferDualStack takes two where the cluster offers them, and RequireDualStack insists on two.',
        docsUrl: DUAL_STACK_DOCS,
        fix: {
          title: 'Change to PreferDualStack',
          safe: false,
          ops: [{ op: 'set', path: ['spec', 'ipFamilyPolicy'], value: 'PreferDualStack' }],
        },
      });
    }
  }

  if (type === TYPE_EXTERNAL_NAME) {
    for (const field of ['ipFamilies', 'ipFamilyPolicy'] as const) {
      if (spec[field] === undefined) continue;
      ctx.report({
        ruleId: 'service/ip-family-not-allowed',
        severity: 'error',
        path: ['spec', field],
        anchor: 'key',
        message: `${field} may not be set on an ExternalName Service.`,
        explanation:
          'IP families describe the addresses allocated to a Service, and an ExternalName Service is allocated none — it is a CNAME to a name resolved elsewhere.',
        docsUrl: DUAL_STACK_DOCS,
      });
    }
  }
}
