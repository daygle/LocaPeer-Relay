// NIP-01 tag filters are single-character keys prefixed with '#', e.g. "#p" or "#e".
export function isTagFilterKey(key: string): boolean {
  return key.startsWith('#') && key.length === 2;
}
