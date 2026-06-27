import { createHash } from 'crypto';
import { NostrEvent } from './types';

export function verifyEventId(event: NostrEvent): boolean {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  const hash = createHash('sha256').update(serialized).digest('hex');
  return hash === event.id;
}

export function validateEvent(event: unknown): event is NostrEvent {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return (
    typeof e.id === 'string' && e.id.length === 64 &&
    typeof e.pubkey === 'string' && e.pubkey.length === 64 &&
    typeof e.created_at === 'number' &&
    typeof e.kind === 'number' &&
    Array.isArray(e.tags) &&
    typeof e.content === 'string' &&
    typeof e.sig === 'string' && e.sig.length === 128
  );
}
