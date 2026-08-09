/**
 * IP address and CIDR formats, as the apiserver reads them.
 *
 * Kubernetes parses these with Go's net/netip, which since Go 1.17 rejects the
 * forms C's inet_aton used to accept — a leading zero in an octet is an error
 * rather than an octal escape, and there are no three-part or single-integer
 * addresses. The parsers here match that, since a manifest carrying "010.1.1.1"
 * is rejected by the apiserver rather than read as 8.1.1.1.
 */

import type { FormatCheck } from './names.js';

export interface IPCheck extends FormatCheck {
  /** 4 or 6, when the value parsed. */
  family?: 4 | 6;
}

export function isIPAddress(value: string): IPCheck {
  if (value.length === 0) return { ok: false, reason: 'must not be empty' };
  return value.includes(':') ? parseIPv6(value) : parseIPv4(value);
}

/** A CIDR block: an address and a prefix length its family allows. */
export function isCIDR(value: string): IPCheck {
  const slash = value.indexOf('/');
  if (slash === -1) {
    return { ok: false, reason: 'must include a prefix length, such as "10.0.0.0/8"' };
  }

  const address = isIPAddress(value.slice(0, slash));
  if (!address.ok) return { ok: false, reason: `has an address part that ${address.reason}` };

  const bits = value.slice(slash + 1);
  const max = address.family === 4 ? 32 : 128;
  if (!/^\d+$/.test(bits) || Number(bits) > max) {
    return {
      ok: false,
      reason: `must have a prefix length between 0 and ${max} for an IPv${address.family} block`,
    };
  }
  return { ok: true, family: address.family };
}

/**
 * Addresses the apiserver refuses in externalIPs, mirroring
 * validateNonSpecialIP: an address that only means something to the node
 * itself can never be one a client outside it reaches the Service on.
 */
export function isSpecialIP(value: string): string | undefined {
  const parsed = isIPAddress(value);
  if (!parsed.ok) return undefined;

  if (parsed.family === 4) {
    const octets = value.split('.').map(Number);
    if (value === '0.0.0.0') return 'is the unspecified address';
    if (octets[0] === 127) return 'is a loopback address';
    if (octets[0] === 169 && octets[1] === 254) return 'is a link-local address';
    if (octets[0] === 224 && octets[1] === 0 && octets[2] === 0) return 'is a link-local multicast address';
    return undefined;
  }

  const lower = value.toLowerCase();
  if (/^0*:(0*:)*0*$/.test(lower)) return 'is the unspecified address';
  if (/^(0*:)*0*:0*1$/.test(lower)) return 'is a loopback address';
  // fe80::/10 is link-local unicast, ff02::/16 link-local multicast.
  if (/^fe[89ab]/.test(lower)) return 'is a link-local address';
  if (/^ff0*2:/.test(lower)) return 'is a link-local multicast address';
  return undefined;
}

function parseIPv4(value: string): IPCheck {
  const octets = value.split('.');
  if (octets.length !== 4) {
    return { ok: false, reason: 'must be four dot-separated numbers, such as "10.0.0.1"' };
  }
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) {
      return { ok: false, reason: 'must be four dot-separated numbers, such as "10.0.0.1"' };
    }
    if (octet.length > 1 && octet.startsWith('0')) {
      return { ok: false, reason: 'must not have a leading zero in an octet' };
    }
    if (Number(octet) > 255) return { ok: false, reason: 'has an octet above 255' };
  }
  return { ok: true, family: 4 };
}

function parseIPv6(value: string): IPCheck {
  const halves = value.split('::');
  if (halves.length > 2) {
    return { ok: false, reason: 'must not contain "::" more than once' };
  }

  const groups: string[] = [];
  let expected = 8;
  for (const [index, half] of halves.entries()) {
    const parts = half.length === 0 ? [] : half.split(':');
    // A trailing dotted-quad ("::ffff:10.0.0.1") stands in for the last two groups.
    const last = parts[parts.length - 1];
    if (index === halves.length - 1 && last !== undefined && last.includes('.')) {
      const embedded = parseIPv4(last);
      if (!embedded.ok) return { ok: false, reason: `has an embedded IPv4 address that ${embedded.reason}` };
      parts.pop();
      expected -= 2;
    }
    groups.push(...parts);
  }

  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
      return { ok: false, reason: 'must be groups of up to four hexadecimal digits separated by ":"' };
    }
  }

  if (halves.length === 2) {
    if (groups.length >= expected) {
      return { ok: false, reason: '"::" must stand for at least one group of zeros' };
    }
  } else if (groups.length !== expected) {
    return { ok: false, reason: `must have ${expected} groups, or use "::" to elide a run of zeros` };
  }
  return { ok: true, family: 6 };
}
