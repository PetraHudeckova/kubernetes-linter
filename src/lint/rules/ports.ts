import { isPortName } from '../../k8s/names.js';
import { asNumber, asObject, asString, type Rule, type RuleContext } from './context.js';

const MIN_PORT = 1;
const MAX_PORT = 65535;

export const portsRule: Rule = {
  id: 'pod/ports',
  run(ctx: RuleContext) {
    const hostNetwork = ctx.spec['hostNetwork'] === true;
    const portNames = new Map<string, string>();
    const hostBindings = new Map<string, string>();

    for (const ref of ctx.containers) {
      const ports = ref.container['ports'];
      if (!Array.isArray(ports)) continue;

      ports.forEach((entry, index) => {
        const port = asObject(entry);
        if (!port) return;
        const path = [...ref.path, 'ports', index];

        const containerPort = asNumber(port['containerPort']);
        if (containerPort !== undefined) {
          checkRange(ctx, [...path, 'containerPort'], 'containerPort', containerPort);
        }

        const hostPort = asNumber(port['hostPort']);
        if (hostPort !== undefined) {
          checkRange(ctx, [...path, 'hostPort'], 'hostPort', hostPort);
        }

        const name = asString(port['name']);
        if (name !== undefined) {
          const check = isPortName(name);
          if (!check.ok) {
            ctx.report({
              ruleId: 'pod/invalid-port-name',
              severity: 'error',
              path: [...path, 'name'],
              message: `"${name}" is not a valid port name: it ${check.reason}.`,
              explanation:
                'Port names follow IANA service name rules: at most 15 characters, lowercase letters, digits and "-", containing at least one letter, with no leading, trailing or repeated hyphens. Services reference these names in targetPort.',
            });
          }

          const previous = portNames.get(name);
          if (previous) {
            ctx.report({
              ruleId: 'pod/duplicate-port-name',
              severity: 'error',
              path: [...path, 'name'],
              message: `Port name "${name}" is already used by ${previous}.`,
              explanation:
                'Port names must be unique across the whole Pod, since a Service selects a target port by name without knowing which container it belongs to.',
            });
          } else {
            portNames.set(name, ref.label);
          }
        }

        const protocol = asString(port['protocol']) ?? 'TCP';

        if (hostPort !== undefined) {
          const hostIP = asString(port['hostIP']) ?? '0.0.0.0';
          const key = `${hostIP}/${hostPort}/${protocol}`;
          const previous = hostBindings.get(key);
          if (previous) {
            ctx.report({
              ruleId: 'pod/duplicate-host-port',
              severity: 'error',
              path: [...path, 'hostPort'],
              message: `Host port ${hostIP}:${hostPort}/${protocol} is already claimed by ${previous}.`,
              explanation:
                'A host port is a binding on the node itself, so the same address, port and protocol cannot be claimed twice.',
            });
          } else {
            hostBindings.set(key, ref.label);
          }
        }

        if (hostNetwork && hostPort !== undefined && containerPort !== undefined && hostPort !== containerPort) {
          ctx.report({
            ruleId: 'pod/host-network-port-mismatch',
            severity: 'error',
            path: [...path, 'hostPort'],
            message: `With hostNetwork: true, hostPort (${hostPort}) must equal containerPort (${containerPort}).`,
            explanation:
              'On the host network there is no port remapping — the container binds directly to the node\'s network namespace, so the two numbers describe the same socket.',
            fix: {
              title: `Set hostPort to ${containerPort}`,
              safe: true,
              ops: [{ op: 'set', path: [...path, 'hostPort'], value: containerPort }],
            },
          });
        }
      });
    }
  },
};

function checkRange(ctx: RuleContext, path: (string | number)[], field: string, value: number): void {
  if (!Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) {
    ctx.report({
      ruleId: 'pod/port-out-of-range',
      severity: 'error',
      path,
      message: `${field} ${value} is out of range; it must be between ${MIN_PORT} and ${MAX_PORT}.`,
      explanation: 'TCP and UDP port numbers are 16-bit, and 0 is not assignable.',
    });
  }
}
