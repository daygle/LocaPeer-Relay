import net from 'net';
import { banIp, isIpBanned, pruneBans, auditLog } from './db';
import { isPrivateAddress } from './clientip';
import { settings } from './settings';
import { log, error } from './log';

// Automatic bans for misbehaving clients. Offences add weighted strikes to a
// per-IP score; reaching AUTOBAN_STRIKES within AUTOBAN_WINDOW_SECONDS bans
// the IP. Strike scores are per process (a short-lived signal); the bans
// themselves are stored in the shared database.
//
// Loopback and private addresses are never banned: behind the Cloudflare
// Tunnel with CF-Connecting-IP disabled every client shares the cloudflared
// container's address, and banning it would cut off everyone.

// Strike weights. A legitimate LocaPeer client never sends malformed or
// badly signed events, so those count fully. Hitting the message rate limit
// can happen to a real phone flushing a large offline queue, so only a
// connection the relay had to close for flooding counts, and per-IP
// connection-cap hits don't count at all (shared IPs, e.g. mobile CGNAT,
// can hit the cap innocently).
export const STRIKE = {
  invalidEvent: 1,       // bad structure, id mismatch or signature failure
  malformedMessage: 1,   // unparseable JSON, unknown verb, malformed REQ
  connectRateLimited: 1, // over the per-IP new-connection rate
  floodClosed: 5,        // connection closed after repeated rate-limit violations
} as const;

// Longest a repeat offender's ban can grow to by doubling.
const MAX_BAN_MS = 7 * 24 * 60 * 60_000;
const PRUNE_INTERVAL_MS = 5 * 60_000;

interface StrikeState {
  score: number;
  windowStart: number;
}

const strikes = new Map<string, StrikeState>();

export function isBannable(ip: string): boolean {
  return net.isIP(ip) !== 0 && !isPrivateAddress(ip);
}

export function isBanned(ip: string): boolean {
  if (!isBannable(ip)) return false;
  try {
    return isIpBanned(ip);
  } catch (err) {
    error('[!] ban lookup error:', err);
    return false;
  }
}

// Record an offence. Returns true when this strike got the IP banned, so the
// caller can drop the IP's open connections.
export function strike(ip: string, reason: string, weight: number): boolean {
  if (settings.getInt('AUTOBAN_ENABLED') !== 1 || !isBannable(ip)) return false;
  const now = Date.now();
  const windowMs = settings.getInt('AUTOBAN_WINDOW_SECONDS') * 1000;
  let state = strikes.get(ip);
  if (!state || now - state.windowStart > windowMs) {
    state = { score: 0, windowStart: now };
    strikes.set(ip, state);
  }
  state.score += weight;
  if (state.score < settings.getInt('AUTOBAN_STRIKES')) return false;

  strikes.delete(ip);
  try {
    const ban = banIp(ip, reason, state.score, settings.getInt('AUTOBAN_DURATION_MINUTES') * 60_000, MAX_BAN_MS);
    const minutes = Math.round((ban.expiresAt - ban.bannedAt) / 60_000);
    log(`[ban] ${ip} banned for ${minutes}m (${reason}, ${state.score} strikes, ban #${ban.banCount})`);
    auditLog('auto_ban', ip, `${reason}; ${state.score} strikes; ${minutes}m; ban #${ban.banCount}`);
    return true;
  } catch (err) {
    error('[!] ban error:', err);
    return false;
  }
}

setInterval(() => {
  const now = Date.now();
  const windowMs = settings.getInt('AUTOBAN_WINDOW_SECONDS') * 1000;
  for (const [ip, state] of strikes) {
    if (now - state.windowStart > windowMs) strikes.delete(ip);
  }
  try {
    pruneBans();
  } catch (err) {
    error('[!] ban prune error:', err);
  }
}, PRUNE_INTERVAL_MS).unref();
