/**
 * Name and identifier formats enforced by the Kubernetes apiserver.
 * Mirrors k8s.io/apimachinery/pkg/util/validation.
 */

export interface FormatCheck {
  ok: boolean;
  reason?: string;
}

const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS_1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const DNS_1035_LABEL = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const C_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUALIFIED_NAME = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)$/;
const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;

export const DNS_1123_LABEL_MAX = 63;
export const DNS_1123_SUBDOMAIN_MAX = 253;
export const DNS_1035_LABEL_MAX = 63;
export const PORT_NAME_MAX = 15;

export function isDNS1123Label(value: string): FormatCheck {
  if (value.length === 0) return { ok: false, reason: 'must not be empty' };
  if (value.length > DNS_1123_LABEL_MAX)
    return { ok: false, reason: `must be at most ${DNS_1123_LABEL_MAX} characters` };
  if (!DNS_1123_LABEL.test(value))
    return {
      ok: false,
      reason:
        'must be lowercase alphanumeric or "-", and must start and end with an alphanumeric character',
    };
  return { ok: true };
}

export function isDNS1123Subdomain(value: string): FormatCheck {
  if (value.length === 0) return { ok: false, reason: 'must not be empty' };
  if (value.length > DNS_1123_SUBDOMAIN_MAX)
    return { ok: false, reason: `must be at most ${DNS_1123_SUBDOMAIN_MAX} characters` };
  if (!DNS_1123_SUBDOMAIN.test(value))
    return {
      ok: false,
      reason:
        'must be lowercase alphanumeric, "-" or ".", and must start and end with an alphanumeric character',
    };
  return { ok: true };
}

export function isDNS1035Label(value: string): FormatCheck {
  if (value.length === 0) return { ok: false, reason: 'must not be empty' };
  if (value.length > DNS_1035_LABEL_MAX)
    return { ok: false, reason: `must be at most ${DNS_1035_LABEL_MAX} characters` };
  if (!DNS_1035_LABEL.test(value))
    return { ok: false, reason: 'must start with a letter, and contain only lowercase alphanumerics or "-"' };
  return { ok: true };
}

/**
 * IANA_SVC_NAME, used for container port names: at most 15 characters, lowercase
 * alphanumerics and "-", at least one letter, no leading/trailing/adjacent hyphens.
 */
export function isPortName(value: string): FormatCheck {
  if (value.length === 0) return { ok: false, reason: 'must not be empty' };
  if (value.length > PORT_NAME_MAX)
    return { ok: false, reason: `must be at most ${PORT_NAME_MAX} characters` };
  if (!/^[a-z0-9-]+$/.test(value))
    return { ok: false, reason: 'must contain only lowercase alphanumeric characters or "-"' };
  if (!/[a-z]/.test(value)) return { ok: false, reason: 'must contain at least one letter' };
  if (value.startsWith('-') || value.endsWith('-'))
    return { ok: false, reason: 'must not begin or end with "-"' };
  if (value.includes('--')) return { ok: false, reason: 'must not contain consecutive hyphens' };
  return { ok: true };
}

/** Environment variable names; Kubernetes also permits "." for compatibility. */
export function isEnvVarName(value: string): FormatCheck {
  if (value.length === 0) return { ok: false, reason: 'must not be empty' };
  if (C_IDENTIFIER.test(value)) return { ok: true };
  if (/^[-._a-zA-Z][-._a-zA-Z0-9]*$/.test(value)) return { ok: true };
  return {
    ok: false,
    reason: 'must consist of alphabetic characters, digits, "_", "-" or ".", and must not start with a digit',
  };
}

export function isCIdentifier(value: string): FormatCheck {
  if (!C_IDENTIFIER.test(value))
    return {
      ok: false,
      reason: 'must be a C identifier: letters, digits and "_", not starting with a digit',
    };
  return { ok: true };
}

/**
 * Qualified name, used for label/annotation keys and resource names:
 * an optional DNS-subdomain prefix, "/", then a name of at most 63 characters.
 */
export function isQualifiedName(value: string): FormatCheck {
  const parts = value.split('/');
  let name: string;
  if (parts.length === 1) {
    name = parts[0]!;
  } else if (parts.length === 2) {
    const prefix = parts[0]!;
    name = parts[1]!;
    if (prefix.length === 0) return { ok: false, reason: 'prefix part must not be empty' };
    const prefixCheck = isDNS1123Subdomain(prefix);
    if (!prefixCheck.ok) return { ok: false, reason: `prefix part ${prefixCheck.reason}` };
  } else {
    return { ok: false, reason: 'must not contain more than one "/"' };
  }
  if (name.length === 0) return { ok: false, reason: 'name part must not be empty' };
  if (name.length > DNS_1123_LABEL_MAX)
    return { ok: false, reason: `name part must be at most ${DNS_1123_LABEL_MAX} characters` };
  if (!QUALIFIED_NAME.test(name))
    return {
      ok: false,
      reason:
        'name part must consist of alphanumerics, "-", "_" or ".", and must start and end with an alphanumeric character',
    };
  return { ok: true };
}

export function isLabelValue(value: string): FormatCheck {
  if (value.length > DNS_1123_LABEL_MAX)
    return { ok: false, reason: `must be at most ${DNS_1123_LABEL_MAX} characters` };
  if (!LABEL_VALUE.test(value))
    return {
      ok: false,
      reason:
        'must consist of alphanumerics, "-", "_" or ".", and must start and end with an alphanumeric character',
    };
  return { ok: true };
}

/** Suggest a lowercase/trimmed variant when a name is nearly valid. */
export function suggestName(value: string): string | undefined {
  const candidate = value.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
  return candidate.length > 0 && candidate !== value ? candidate : undefined;
}
