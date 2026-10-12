import { IncomingMessage } from 'http';
import net from 'net';
import { settings } from './settings';

// Behind a Cloudflare Tunnel (or any local reverse proxy) every connection
// arrives from the proxy's address, so per-IP limits would lump all clients
// together. Cloudflare passes the real client address in CF-Connecting-IP.
//
// The header is only trusted when the direct peer is a loopback or private
// address, i.e. a proxy on this host or network such as the cloudflared
// container. A client connecting straight from the internet has a public
// address, so it can't spoof its identity by sending the header itself.

function stripMappedPrefix(addr: string): string {
  return addr.toLowerCase().startsWith('::ffff:') && net.isIPv4(addr.slice(7)) ? addr.slice(7) : addr;
}

export function isPrivateAddress(raw: string): boolean {
  const addr = stripMappedPrefix(raw);
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    return (
      a === 127 ||                          // loopback
      a === 10 ||                           // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12 (Docker bridges)
      (a === 192 && b === 168)              // 192.168.0.0/16
    );
  }
  if (net.isIPv6(addr)) {
    const lower = addr.toLowerCase();
    return lower === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(lower); // loopback, fc00::/7
  }
  return false;
}

export function getClientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  if (settings.getInt('TRUST_CF_CONNECTING_IP') !== 1 || !isPrivateAddress(peer)) {
    return peer;
  }
  const header = req.headers['cf-connecting-ip'];
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  return value && net.isIP(value) ? stripMappedPrefix(value) : peer;
}
