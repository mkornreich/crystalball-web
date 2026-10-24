/**
 * Convert an NRBF object graph (which may contain bigints, Maps, typed arrays
 * and shared/cyclic references) into something JSON.stringify accepts.
 * A repeated object is emitted once; later occurrences become `{ $ref: n }`
 * pointing at the `$id` given to its first occurrence.
 */

export function toJsonSafe(root: unknown): unknown {
  const ids = new Map<object, number>();
  const seenTwice = new Set<object>();
  // First pass: find objects referenced more than once.
  const scan = (v: unknown): void => {
    if (typeof v !== 'object' || v === null) return;
    if (ids.has(v)) {
      seenTwice.add(v);
      return;
    }
    ids.set(v, ids.size + 1);
    if (v instanceof Map) for (const [k, x] of v) (scan(k), scan(x));
    else if (Array.isArray(v)) v.forEach(scan);
    else if (!(v instanceof Uint8Array)) for (const x of Object.values(v)) scan(x);
  };
  scan(root);
  const emitted = new Set<object>();
  const conv = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
    if (typeof v !== 'object' || v === null) return v;
    if (emitted.has(v)) return { $ref: ids.get(v) };
    emitted.add(v);
    const tag = seenTwice.has(v) ? { $id: ids.get(v) } : {};
    if (v instanceof Uint8Array) return { ...tag, $bytes: Array.from(v.subarray(0, 64)), length: v.length };
    if (v instanceof Map) return { ...tag, $map: Array.from(v, ([k, x]) => [conv(k), conv(x)]) };
    if (Array.isArray(v)) return seenTwice.has(v) ? { ...tag, $array: v.map(conv) } : v.map(conv);
    const out: Record<string, unknown> = { ...tag };
    for (const [k, x] of Object.entries(v)) out[k] = conv(x);
    return out;
  };
  return conv(root);
}
