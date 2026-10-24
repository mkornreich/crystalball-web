/**
 * A general reader for the .NET BinaryFormatter wire format, as published in
 * [MS-NRBF] ".NET Remoting: Binary Format Data Structure".
 *
 * `parseNrbf` decodes a whole stream (SerializationHeader … MessageEnd),
 * resolving MemberReferences — including forward references and cycles — so
 * the result is a graph of plain JS values:
 *
 *   - a class instance  → `NrbfObject`: `{ $type, $assembly, ...members }`
 *   - a string           → `string`
 *   - an array           → `NrbfValue[]` (Byte[] → `Uint8Array`); a multi-
 *                          dimensional array is nested row-major
 *   - Boolean / numbers  → `boolean` / `number` (Int64/UInt64 outside the safe
 *                          integer range → `bigint`); Char → 1-char string;
 *                          Decimal → its invariant string; DateTime →
 *                          `NrbfDateTime`; TimeSpan → ticks
 *   - null               → `null`
 *
 * `simplifyNrbf` then collapses common framework types (Guid, Version,
 * ArrayList, List<T>, Hashtable, Dictionary<K,V>, enums' `value__` boxes) into
 * natural JS shapes. Remoting method-call records (21/22) are not supported —
 * they never appear in a BinaryFormatter.Serialize stream.
 */

export interface NrbfObject {
  /** Full .NET type name, e.g. "Decisioneering.OCB.SimKernel.Asm". */
  $type: string;
  /** Assembly display name ("mscorlib" for system classes). */
  $assembly: string;
  [member: string]: NrbfValue;
}

export interface NrbfDateTime {
  $type: 'System.DateTime';
  $assembly: 'mscorlib';
  ticks: bigint;
  /** 0 = Unspecified, 1 = Utc, 2 = Local. */
  kind: number;
}

export type NrbfValue =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | NrbfDateTime
  | NrbfObject
  | NrbfValue[]
  | Map<NrbfValue, NrbfValue>;

/* ------------------------------ enums ------------------------------ */

const enum Rec {
  SerializedStreamHeader = 0,
  ClassWithId = 1,
  SystemClassWithMembers = 2,
  ClassWithMembers = 3,
  SystemClassWithMembersAndTypes = 4,
  ClassWithMembersAndTypes = 5,
  BinaryObjectString = 6,
  BinaryArray = 7,
  MemberPrimitiveTyped = 8,
  MemberReference = 9,
  ObjectNull = 10,
  MessageEnd = 11,
  BinaryLibrary = 12,
  ObjectNullMultiple256 = 13,
  ObjectNullMultiple = 14,
  ArraySinglePrimitive = 15,
  ArraySingleObject = 16,
  ArraySingleString = 17,
  MethodCall = 21,
  MethodReturn = 22,
}

const enum BinType {
  Primitive = 0,
  String = 1,
  Object = 2,
  SystemClass = 3,
  Class = 4,
  ObjectArray = 5,
  StringArray = 6,
  PrimitiveArray = 7,
}

const enum Prim {
  Boolean = 1,
  Byte = 2,
  Char = 3,
  Decimal = 5,
  Double = 6,
  Int16 = 7,
  Int32 = 8,
  Int64 = 9,
  SByte = 10,
  Single = 11,
  TimeSpan = 12,
  DateTime = 13,
  UInt16 = 14,
  UInt32 = 15,
  UInt64 = 16,
  Null = 17,
  String = 18,
}

interface MemberType {
  bin: BinType;
  /** PrimitiveTypeEnum for Primitive / PrimitiveArray. */
  prim?: Prim;
  /** Class name for SystemClass / Class. */
  className?: string;
}

interface ClassMeta {
  name: string;
  library: string;
  memberNames: string[];
  /** Undefined for the *WithMembers (untyped) record variants. */
  memberTypes?: MemberType[];
}

/** Marker returned by readRecord for ObjectNullMultiple*. */
interface NullRun {
  nullRun: number;
}

/** A not-yet-resolved MemberReference. */
class Ref {
  constructor(readonly id: number) {}
}

const SYSTEM_LIB = 'mscorlib';
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

export class NrbfError extends Error {}

/* ------------------------------ reader ------------------------------ */

class Reader {
  pos = 0;
  private readonly view: DataView;
  private readonly utf8 = new TextDecoder('utf-8');

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private need(n: number): void {
    if (this.pos + n > this.bytes.byteLength) {
      throw new NrbfError(`nrbf: unexpected end of stream at offset ${this.pos} (need ${n} bytes)`);
    }
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.pos++];
  }
  i8(): number {
    this.need(1);
    return this.view.getInt8(this.pos++);
  }
  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i64(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  bytesN(n: number): Uint8Array {
    this.need(n);
    const v = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  /** LengthPrefixedString: 7-bit-encoded byte length, then UTF-8. */
  lps(): string {
    let len = 0;
    for (let shift = 0; ; shift += 7) {
      if (shift > 28) throw new NrbfError('nrbf: bad string length prefix');
      const b = this.u8();
      len |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
    }
    this.need(len);
    const s = this.utf8.decode(this.bytes.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
  /** A single UTF-8 encoded Char. */
  char(): string {
    const b0 = this.bytes[this.pos];
    const n = b0 < 0x80 ? 1 : b0 < 0xe0 ? 2 : b0 < 0xf0 ? 3 : 4;
    this.need(n);
    const s = this.utf8.decode(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
}

function int64ToValue(v: bigint): number | bigint {
  return v <= MAX_SAFE && v >= MIN_SAFE ? Number(v) : v;
}

/* ------------------------------ parser ------------------------------ */

class Parser {
  private readonly r: Reader;
  private readonly libraries = new Map<number, string>();
  private readonly metas = new Map<number, ClassMeta>();
  private readonly objects = new Map<number, NrbfValue>();
  private readonly fixups: { target: Record<string, NrbfValue> | NrbfValue[]; key: string | number; ref: Ref }[] = [];
  rootId = 0;

  constructor(bytes: Uint8Array) {
    this.r = new Reader(bytes);
  }

  parse(): NrbfValue {
    const r = this.r;
    if (r.u8() !== Rec.SerializedStreamHeader) throw new NrbfError('nrbf: missing SerializationHeader record');
    this.rootId = r.i32();
    r.i32(); // headerId
    const major = r.i32();
    const minor = r.i32();
    if (major !== 1 || minor !== 0) throw new NrbfError(`nrbf: unsupported format version ${major}.${minor}`);
    for (;;) {
      const v = this.readRecord();
      if (v === END) break;
    }
    // Resolve forward references now that every object id is known.
    for (const f of this.fixups) {
      if (!this.objects.has(f.ref.id)) throw new NrbfError(`nrbf: unresolved reference to object ${f.ref.id}`);
      (f.target as Record<string | number, NrbfValue>)[f.key] = this.objects.get(f.ref.id) as NrbfValue;
    }
    if (!this.objects.has(this.rootId)) throw new NrbfError(`nrbf: root object ${this.rootId} not found`);
    return this.objects.get(this.rootId) as NrbfValue;
  }

  /** Store `v` at target[key], deferring unresolved references. */
  private assign(target: Record<string, NrbfValue> | NrbfValue[], key: string | number, v: NrbfValue | Ref): void {
    if (v instanceof Ref) {
      if (this.objects.has(v.id)) (target as Record<string | number, NrbfValue>)[key] = this.objects.get(v.id) as NrbfValue;
      else {
        (target as Record<string | number, NrbfValue>)[key] = null;
        this.fixups.push({ target, key, ref: v });
      }
    } else (target as Record<string | number, NrbfValue>)[key] = v;
  }

  private register(id: number, v: NrbfValue): void {
    if (id !== 0) this.objects.set(id, v);
  }

  /** Read one record; returns its value, a Ref, a NullRun, or END. */
  private readRecord(): NrbfValue | Ref | NullRun | typeof END {
    const r = this.r;
    const at = r.pos;
    const type = r.u8() as Rec;
    switch (type) {
      case Rec.BinaryLibrary: {
        const id = r.i32();
        this.libraries.set(id, r.lps());
        return this.readRecord(); // a library record always precedes the record that uses it
      }
      case Rec.ClassWithMembersAndTypes: {
        const meta = this.readClassInfo();
        meta.memberTypes = this.readMemberTypes(meta.memberNames.length);
        meta.library = this.lib(r.i32());
        return this.readClassBody(meta);
      }
      case Rec.SystemClassWithMembersAndTypes: {
        const meta = this.readClassInfo();
        meta.memberTypes = this.readMemberTypes(meta.memberNames.length);
        meta.library = SYSTEM_LIB;
        return this.readClassBody(meta);
      }
      case Rec.ClassWithMembers: {
        const meta = this.readClassInfo();
        meta.library = this.lib(r.i32());
        return this.readClassBody(meta);
      }
      case Rec.SystemClassWithMembers: {
        const meta = this.readClassInfo();
        meta.library = SYSTEM_LIB;
        return this.readClassBody(meta);
      }
      case Rec.ClassWithId: {
        const id = r.i32();
        const metaId = r.i32();
        const meta = this.metas.get(metaId);
        if (!meta) throw new NrbfError(`nrbf: ClassWithId references unknown metadata ${metaId}`);
        return this.readClassBody(meta, id);
      }
      case Rec.BinaryObjectString: {
        const id = r.i32();
        const s = r.lps();
        this.register(id, s);
        return s;
      }
      case Rec.MemberPrimitiveTyped:
        return this.readPrimitive(r.u8() as Prim);
      case Rec.MemberReference:
        return new Ref(r.i32());
      case Rec.ObjectNull:
        return null;
      case Rec.ObjectNullMultiple256:
        return { nullRun: r.u8() };
      case Rec.ObjectNullMultiple:
        return { nullRun: r.i32() };
      case Rec.MessageEnd:
        return END;
      case Rec.ArraySinglePrimitive: {
        const id = r.i32();
        const len = r.i32();
        const arr = this.readPrimitiveArray(r.u8() as Prim, len);
        this.register(id, arr);
        return arr;
      }
      case Rec.ArraySingleObject:
      case Rec.ArraySingleString: {
        const id = r.i32();
        const len = r.i32();
        const arr: NrbfValue[] = new Array(len);
        this.register(id, arr);
        this.readRecordElements(arr, len);
        return arr;
      }
      case Rec.BinaryArray:
        return this.readBinaryArray();
      case Rec.SerializedStreamHeader:
      case Rec.MethodCall:
      case Rec.MethodReturn:
      default:
        throw new NrbfError(`nrbf: unsupported record type ${type} at offset ${at}`);
    }
  }

  private lib(id: number): string {
    const name = this.libraries.get(id);
    if (name === undefined) throw new NrbfError(`nrbf: unknown library id ${id}`);
    return name;
  }

  private readClassInfo(): ClassMeta & { id: number } {
    const r = this.r;
    const id = r.i32();
    const name = r.lps();
    const count = r.i32();
    const memberNames: string[] = [];
    for (let i = 0; i < count; i++) memberNames.push(r.lps());
    return { id, name, library: '', memberNames };
  }

  private readMemberTypes(count: number): MemberType[] {
    const r = this.r;
    const types: MemberType[] = [];
    for (let i = 0; i < count; i++) types.push({ bin: r.u8() as BinType });
    for (const t of types) this.readAdditionalInfo(t);
    return types;
  }

  private readAdditionalInfo(t: MemberType): void {
    const r = this.r;
    switch (t.bin) {
      case BinType.Primitive:
      case BinType.PrimitiveArray:
        t.prim = r.u8() as Prim;
        break;
      case BinType.SystemClass:
        t.className = r.lps();
        break;
      case BinType.Class:
        t.className = r.lps();
        r.i32(); // libraryId
        break;
      default:
        break;
    }
  }

  private readClassBody(meta: ClassMeta & { id?: number }, idOverride?: number): NrbfObject {
    const id = idOverride ?? meta.id ?? 0;
    if (idOverride === undefined && meta.id !== undefined) {
      // Keep only the reusable metadata (not the object id) for later ClassWithId records.
      this.metas.set(meta.id, { name: meta.name, library: meta.library, memberNames: meta.memberNames, memberTypes: meta.memberTypes });
    }
    const obj: NrbfObject = { $type: meta.name, $assembly: meta.library };
    this.register(id, obj);
    const n = meta.memberNames.length;
    for (let i = 0; i < n; i++) {
      const name = meta.memberNames[i];
      const t = meta.memberTypes?.[i];
      let v: NrbfValue | Ref | NullRun | typeof END;
      if (t && t.bin === BinType.Primitive) v = this.readPrimitive(t.prim as Prim);
      else {
        v = this.readRecord();
        if (v === END || isNullRun(v)) throw new NrbfError(`nrbf: unexpected record in member ${meta.name}.${name}`);
      }
      this.assign(obj, name, v);
    }
    return obj;
  }

  private readRecordElements(arr: NrbfValue[], len: number): void {
    for (let i = 0; i < len; ) {
      const v = this.readRecord();
      if (v === END) throw new NrbfError('nrbf: MessageEnd inside array');
      if (isNullRun(v)) {
        for (let k = 0; k < v.nullRun && i < len; k++) arr[i++] = null;
      } else this.assign(arr, i++, v);
    }
  }

  private readBinaryArray(): NrbfValue[] | Uint8Array {
    const r = this.r;
    const id = r.i32();
    const arrayType = r.u8(); // 0 Single, 1 Jagged, 2 Rectangular, 3-5 *Offset
    const rank = r.i32();
    const lengths: number[] = [];
    for (let i = 0; i < rank; i++) lengths.push(r.i32());
    if (arrayType >= 3) for (let i = 0; i < rank; i++) r.i32(); // lower bounds (ignored: JS arrays are 0-based)
    const t: MemberType = { bin: r.u8() as BinType };
    this.readAdditionalInfo(t);
    const total = lengths.reduce((a, b) => a * b, 1);
    let flat: NrbfValue[] | Uint8Array;
    if (t.bin === BinType.Primitive) {
      flat = this.readPrimitiveArray(t.prim as Prim, total);
    } else {
      flat = new Array(total);
      this.readRecordElements(flat, total);
    }
    const result = rank <= 1 ? flat : reshape(flat, lengths);
    this.register(id, result);
    return result;
  }

  private readPrimitiveArray(p: Prim, len: number): NrbfValue[] | Uint8Array {
    if (p === Prim.Byte) return this.r.bytesN(len);
    const arr: NrbfValue[] = new Array(len);
    for (let i = 0; i < len; i++) arr[i] = this.readPrimitive(p);
    return arr;
  }

  private readPrimitive(p: Prim): NrbfValue {
    const r = this.r;
    switch (p) {
      case Prim.Boolean:
        return r.u8() !== 0;
      case Prim.Byte:
        return r.u8();
      case Prim.SByte:
        return r.i8();
      case Prim.Char:
        return r.char();
      case Prim.Decimal:
        return r.lps();
      case Prim.Double:
        return r.f64();
      case Prim.Single:
        return r.f32();
      case Prim.Int16:
        return r.i16();
      case Prim.UInt16:
        return r.u16();
      case Prim.Int32:
        return r.i32();
      case Prim.UInt32:
        return r.u32();
      case Prim.Int64:
        return int64ToValue(r.i64());
      case Prim.UInt64:
        return int64ToValue(r.u64());
      case Prim.TimeSpan:
        return int64ToValue(r.i64());
      case Prim.DateTime: {
        const raw = r.u64();
        return {
          $type: 'System.DateTime',
          $assembly: 'mscorlib',
          ticks: raw & 0x3fffffffffffffffn,
          kind: Number(raw >> 62n),
        };
      }
      case Prim.Null:
        return null;
      case Prim.String:
        return r.lps();
      default:
        throw new NrbfError(`nrbf: unknown primitive type ${p}`);
    }
  }
}

const END = Symbol('MessageEnd');

function isNullRun(v: unknown): v is NullRun {
  return typeof v === 'object' && v !== null && 'nullRun' in v && !(v as object as NrbfObject).$type;
}

function reshape(flat: NrbfValue[] | Uint8Array, lengths: number[]): NrbfValue[] {
  const build = (dim: number, offset: number): NrbfValue[] => {
    const out: NrbfValue[] = [];
    const stride = lengths.slice(dim + 1).reduce((a, b) => a * b, 1);
    for (let i = 0; i < lengths[dim]; i++) {
      out.push(dim === lengths.length - 1 ? (flat[offset + i] as NrbfValue) : build(dim + 1, offset + i * stride));
    }
    return out;
  };
  return build(0, 0);
}

/** Parse a complete BinaryFormatter stream and return the root object graph. */
export function parseNrbf(bytes: Uint8Array): NrbfValue {
  return new Parser(bytes).parse();
}

/* ---------------------------- simplification ---------------------------- */

export function isNrbfObject(v: unknown): v is NrbfObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Map) && !(v instanceof Uint8Array) && typeof (v as NrbfObject).$type === 'string';
}

function hex(n: number, width: number): string {
  return (n >>> 0).toString(16).padStart(width, '0').slice(-width);
}

/** Format a serialized System.Guid ({_a.._k}) as "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx". */
export function guidToString(g: NrbfObject): string {
  const b = (k: string) => hex(Number(g[k]) & 0xff, 2);
  return (
    hex(Number(g._a), 8) +
    '-' +
    hex(Number(g._b) & 0xffff, 4) +
    '-' +
    hex(Number(g._c) & 0xffff, 4) +
    '-' +
    b('_d') +
    b('_e') +
    '-' +
    b('_f') + b('_g') + b('_h') + b('_i') + b('_j') + b('_k')
  );
}

/** Strip generic-argument and assembly qualifiers: "System.Collections.Generic.List`1[[…]]" → "System.Collections.Generic.List`1". */
export function baseTypeName(typeName: string): string {
  const i = typeName.indexOf('[');
  return i < 0 ? typeName : typeName.slice(0, i);
}

/**
 * Collapse well-known framework types into natural JS shapes, preserving
 * object identity (shared references stay shared, cycles are kept):
 *   System.Guid → string, System.Version → "a.b.c.d",
 *   ArrayList / List<T> / Stack / Queue → array (trimmed to its size),
 *   Hashtable / Dictionary<K,V> / SortedList → Map,
 *   an enum box `{ value__: n }` → n.
 */
export function simplifyNrbf(root: NrbfValue): NrbfValue {
  const memo = new Map<object, NrbfValue>();

  const visit = (v: NrbfValue): NrbfValue => {
    if (v === null || v === undefined || typeof v !== 'object' || v instanceof Uint8Array) return v;
    const hit = memo.get(v);
    if (hit !== undefined) return hit;
    if (Array.isArray(v)) {
      const out: NrbfValue[] = new Array(v.length);
      memo.set(v, out);
      for (let i = 0; i < v.length; i++) out[i] = visit(v[i]);
      return out;
    }
    if (v instanceof Map) return v;
    const o = v as NrbfObject;
    if (o.$type === 'System.DateTime') return o;
    const base = baseTypeName(o.$type);
    const keys = Object.keys(o).filter((k) => k !== '$type' && k !== '$assembly');

    if (base === 'System.Guid' && '_a' in o) {
      const s = guidToString(o);
      memo.set(o, s);
      return s;
    }
    if (base === 'System.Version' && '_Major' in o) {
      const parts = [o._Major, o._Minor, o._Build, o._Revision].map(Number).filter((n) => n >= 0);
      const s = parts.join('.');
      memo.set(o, s);
      return s;
    }
    if (keys.length === 1 && keys[0] === 'value__') {
      const n = o.value__ as NrbfValue;
      memo.set(o, n);
      return n;
    }
    if (
      (base === 'System.Collections.ArrayList' || base === 'System.Collections.Generic.List`1') &&
      '_items' in o
    ) {
      const out: NrbfValue[] = [];
      memo.set(o, out);
      const items = (o._items as NrbfValue[] | null) ?? [];
      const size = Number(o._size ?? items.length);
      for (let i = 0; i < size; i++) out.push(visit(items[i]));
      return out;
    }
    if (base === 'System.Collections.Hashtable' && 'Keys' in o && 'Values' in o) {
      const m = new Map<NrbfValue, NrbfValue>();
      memo.set(o, m);
      const ks = (o.Keys as NrbfValue[] | null) ?? [];
      const vs = (o.Values as NrbfValue[] | null) ?? [];
      for (let i = 0; i < ks.length; i++) m.set(visit(ks[i]), visit(vs[i]));
      return m;
    }
    if (base === 'System.Collections.Generic.Dictionary`2' && 'KeyValuePairs' in o) {
      const m = new Map<NrbfValue, NrbfValue>();
      memo.set(o, m);
      for (const kv of (o.KeyValuePairs as NrbfValue[] | null) ?? []) {
        if (isNrbfObject(kv)) m.set(visit(kv.key), visit(kv.value));
      }
      return m;
    }
    if (base === 'System.Collections.SortedList' && 'keys' in o && 'values' in o) {
      const m = new Map<NrbfValue, NrbfValue>();
      memo.set(o, m);
      const ks = (o.keys as NrbfValue[] | null) ?? [];
      const vs = (o.values as NrbfValue[] | null) ?? [];
      const size = Number(o._size ?? ks.length);
      for (let i = 0; i < size; i++) m.set(visit(ks[i]), visit(vs[i]));
      return m;
    }
    const out: NrbfObject = { $type: o.$type, $assembly: o.$assembly };
    memo.set(o, out);
    for (const k of keys) out[k] = visit(o[k]);
    return out;
  };

  return visit(root);
}
