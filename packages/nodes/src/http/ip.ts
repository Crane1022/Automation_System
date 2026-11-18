import net from 'node:net';

/**
 * Returns true for addresses an HTTP Request node must never reach by default:
 * loopback, private ranges, link-local (incl. cloud metadata 169.254.169.254),
 * carrier-grade NAT, multicast, reserved, and IPv6 equivalents.
 */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isBlockedV4(address);
  if (family === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped IPv6 (::ffff:10.0.0.1)
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedV4(mapped[1]);
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('ff')) return true; // multicast
    if (lower.startsWith('64:ff9b:')) return true; // NAT64 can reach private v4
    return false;
  }
  return true; // not an IP at all → block
}

function isBlockedV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}
