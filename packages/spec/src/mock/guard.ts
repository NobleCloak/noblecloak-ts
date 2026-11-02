/**
 * The callback guard: a builder-supplied callback URL is an SSRF vector on a hosted control plane, so
 * only public-routable https hosts are accepted. The mock resolves hostnames from a table of names
 * that resolve to private addresses on the public internet (`localtest.me`, `<ip>.nip.io` in its
 * dotted, dashed and hex spellings), so it
 * needs no DNS; a real server resolves the host and checks the answer.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True when an IPv4 address is loopback, private, link-local, metadata, CGNAT, documentation (TEST-NET-1/2/3) or otherwise not public. */
export function isPrivateIpv4(address: string): boolean {
  const match = IPV4.exec(address);
  if (match === null) return false;
  const [a = 0, b = 0, c = 0] = match.slice(1, 4).map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Parses an IPv6 literal (bracketed or not, dotted-quad tail allowed) into eight 16-bit groups. */
export function parseIpv6(address: string): number[] | undefined {
  let text = address.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail !== null) {
    const octets = tail.slice(1, 5).map(Number);
    if (octets.some((n) => n > 255)) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0] ?? '');
  const rest = halves.length === 2 ? groups(halves[1] ?? '') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return all.map((g) => parseInt(g, 16));
}

/**
 * True when an IPv6 literal is loopback, unspecified, unique-local, link-local, site-local, multicast
 * (ff00::/8), or embeds
 * a non-public IPv4 address (IPv4-mapped ::ffff:0:0/96, SIIT ::ffff:0:0:0/96, IPv4-compatible ::/96,
 * NAT64 64:ff9b::/96, 6to4 2002::/16). The local-use NAT64 prefix 64:ff9b:1::/48 is never public, so
 * it is refused whole. WHATWG URL rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so the check
 * works on the parsed groups, not on text.
 */
export function isPrivateIpv6(address: string): boolean {
  const g = parseIpv6(address);
  if (g === undefined) return false;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const embedded = (hi: number, lo: number): string =>
    [hi >> 8, hi & 255, lo >> 8, lo & 255].map(String).join('.');
  const zeroTo = (n: number): boolean => g.slice(0, n).every((group) => group === 0);
  if (zeroTo(6)) {
    // ::, ::1 and the IPv4-compatible block ::/96 (every address in it is unroutable or embeds IPv4).
    return g6 === 0 || isPrivateIpv4(embedded(g6, g7));
  }
  if (zeroTo(5) && g5 === 0xffff) return isPrivateIpv4(embedded(g6, g7));
  if (zeroTo(4) && g4 === 0xffff && g5 === 0) return isPrivateIpv4(embedded(g6, g7));
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIpv4(embedded(g6, g7));
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  if (g0 === 0x2002) return isPrivateIpv4(embedded(g1, g2));
  return (
    (g0 & 0xfe00) === 0xfc00 ||
    (g0 & 0xffc0) === 0xfe80 ||
    (g0 & 0xffc0) === 0xfec0 ||
    (g0 & 0xff00) === 0xff00
  );
}

const WILDCARD_DNS = /^(.+)\.(?:nip|sslip)\.io$/;
const dotted = (n: number): string =>
  [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].map(String).join('.');

/**
 * The address a wildcard-DNS name (`nip.io`, `sslip.io`) encodes, whatever spelling it uses: dotted
 * (`10.0.0.1.nip.io`, `app.10.0.0.1.nip.io`), dashed (`10-0-0-1.nip.io`, `app-10-0-0-1.nip.io`),
 * hex (`0a000001.nip.io`, `app-0a000001.nip.io`) or, on sslip.io, a dashed IPv6 address.
 */
function wildcardDnsAddress(host: string): string | undefined {
  const prefix = WILDCARD_DNS.exec(host)?.[1];
  if (prefix === undefined) return undefined;
  const labels = prefix.split('.');
  const lastFour = labels.slice(-4);
  if (lastFour.length === 4 && lastFour.every((label) => /^\d{1,3}$/.test(label)))
    return lastFour.join('.');
  const label = labels.at(-1) ?? '';
  const dashed = /(?:^|-)(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$/.exec(label);
  if (dashed !== null) return dashed.slice(1, 5).join('.');
  const hex = /(?:^|-)([0-9a-f]{8})$/.exec(label);
  if (hex?.[1] !== undefined) return dotted(parseInt(hex[1], 16));
  if (/^[0-9a-f-]+$/.test(label) && label.includes('-')) {
    const text = label.replace(/-/g, ':');
    if (parseIpv6(text) !== undefined) return text;
  }
  return undefined;
}

/** The address a hostname resolves to, for the names the mock knows; undefined means a public host. */
export function resolveKnownHost(host: string): string | undefined {
  const wildcard = wildcardDnsAddress(host);
  if (wildcard !== undefined) return wildcard;
  if (host === 'localtest.me' || host.endsWith('.localtest.me')) return '127.0.0.1';
  return undefined;
}

/** Why `url` is not acceptable as a callback, or undefined when it is. */
export function callbackProblem(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'callback_url is not a URL';
  }
  if (parsed.protocol !== 'https:') return 'callback_url must be https';
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host === 'home.arpa' ||
    host.endsWith('.home.arpa')
  ) {
    return `callback_url host ${host} is not public`;
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host))
    return `callback_url address ${host} is not public`;
  // A name with no dot is a search-domain name that resolves inside the network (`intranet`, `db`).
  if (!host.includes('.') && !host.includes(':'))
    return `callback_url host ${host} is a single-label name, which is not public`;
  const resolved = resolveKnownHost(host);
  if (resolved !== undefined && (isPrivateIpv4(resolved) || isPrivateIpv6(resolved))) {
    return `callback_url host ${host} resolves to ${resolved}, which is not public`;
  }
  return undefined;
}
