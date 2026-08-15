import { createHash } from 'crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/curves/utils.js';
import { NostrEvent } from './types';

// NIP-01 event serialization: the event id is the sha256 of this JSON array.
export function serializeEvent(event: NostrEvent): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

export function verifyEventId(event: NostrEvent, serialized?: string): boolean {
  const hash = createHash('sha256').update(serialized ?? serializeEvent(event)).digest('hex');
  return hash === event.id;
}

export function verifySignature(event: NostrEvent): boolean {
  try {
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export function validateEvent(event: unknown): event is NostrEvent {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  if (
    typeof e.id !== 'string' || !HEX64.test(e.id) ||
    typeof e.pubkey !== 'string' || !HEX64.test(e.pubkey) ||
    typeof e.created_at !== 'number' || !Number.isInteger(e.created_at) || e.created_at < 0 ||
    typeof e.kind !== 'number' || !Number.isInteger(e.kind) ||
    typeof e.content !== 'string' ||
    typeof e.sig !== 'string' || !HEX128.test(e.sig)
  ) {
    return false;
  }

  if (!Array.isArray(e.tags)) return false;
  for (const tag of e.tags) {
    if (!Array.isArray(tag) || tag.length === 0) return false;
    for (const item of tag) {
      if (typeof item !== 'string') return false;
    }
  }
  return true;
}
