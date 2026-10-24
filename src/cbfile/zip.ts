/**
 * Minimal ZIP reader and writer for .xlsx/.xlsm packages (no dependencies).
 *
 * Reads the central directory and inflates entries on demand with the
 * platform `DecompressionStream` (available in all evergreen browsers and in
 * Node 18+), so it works both in the Excel add-in and in Node tooling/tests.
 * Only "stored" (0) and "deflate" (8) entries are supported — that is all an
 * OOXML package ever uses. ZIP64 is not supported (packages > 4 GB).
 */

export interface ZipEntry {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** Inflate a zlib (`deflate`) or raw-deflate (`deflate-raw`) byte stream. */
export async function inflate(
  data: Uint8Array,
  format: 'deflate' | 'deflate-raw',
): Promise<Uint8Array> {
  // Copy into a plain ArrayBuffer-backed view (Blob rejects SharedArrayBuffer views).
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export class ZipArchive {
  readonly entries = new Map<string, ZipEntry>();
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.readCentralDirectory();
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  async read(name: string): Promise<Uint8Array> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`zip: no entry "${name}"`);
    const v = this.view;
    const off = entry.localHeaderOffset;
    if (v.getUint32(off, true) !== SIG_LOCAL) throw new Error(`zip: bad local header for "${name}"`);
    const nameLen = v.getUint16(off + 26, true);
    const extraLen = v.getUint16(off + 28, true);
    const start = off + 30 + nameLen + extraLen;
    const raw = this.bytes.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflate(raw, 'deflate-raw');
    throw new Error(`zip: unsupported compression method ${entry.method} for "${name}"`);
  }

  async readText(name: string): Promise<string> {
    return new TextDecoder('utf-8').decode(await this.read(name));
  }

  /** An entry's stored (still compressed) bytes, for copying it into a new archive unchanged. */
  readRaw(name: string): Uint8Array {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`zip: no entry "${name}"`);
    const v = this.view;
    const off = entry.localHeaderOffset;
    const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
    return this.bytes.subarray(start, start + entry.compressedSize);
  }

  private readCentralDirectory(): void {
    const v = this.view;
    const len = this.bytes.byteLength;
    let eocd = -1;
    // The EOCD record is at least 22 bytes and may be followed by a comment (<= 64 KiB).
    for (let i = len - 22; i >= Math.max(0, len - 22 - 0xffff); i--) {
      if (v.getUint32(i, true) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('zip: not a zip file (no end-of-central-directory record)');
    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    if (p === 0xffffffff) throw new Error('zip: ZIP64 archives are not supported');
    const decoder = new TextDecoder('utf-8');
    for (let i = 0; i < count; i++) {
      if (v.getUint32(p, true) !== SIG_CENTRAL) throw new Error('zip: corrupt central directory');
      const method = v.getUint16(p + 10, true);
      const crc32 = v.getUint32(p + 16, true);
      const compressedSize = v.getUint32(p + 20, true);
      const uncompressedSize = v.getUint32(p + 24, true);
      const nameLen = v.getUint16(p + 28, true);
      const extraLen = v.getUint16(p + 30, true);
      const commentLen = v.getUint16(p + 32, true);
      const localHeaderOffset = v.getUint32(p + 42, true);
      const name = decoder.decode(this.bytes.subarray(p + 46, p + 46 + nameLen));
      this.entries.set(name, { name, method, crc32, compressedSize, uncompressedSize, localHeaderOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }
}

/* -------------------------------- writing -------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Raw-deflate with the platform `CompressionStream`. */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One entry of an archive being written: new contents, or another archive's stored bytes as they are. */
export type ZipSource =
  | { name: string; data: Uint8Array }
  | { name: string; raw: Uint8Array; method: number; crc32: number; size: number };

/** Write a ZIP archive (new contents are deflated; copied entries keep their compression). */
export async function writeZip(sources: ZipSource[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // DOS date/time 1980-01-01 00:00 (Excel ignores it).
  const time = 0;
  const date = (0 << 9) | (1 << 5) | 1;
  for (const src of sources) {
    let method: number;
    let crc: number;
    let size: number;
    let body: Uint8Array;
    if ('data' in src) {
      crc = crc32(src.data);
      size = src.data.length;
      const packed = await deflateRaw(src.data);
      if (packed.length < size) {
        method = 8;
        body = packed;
      } else {
        method = 0;
        body = src.data;
      }
    } else {
      ({ method, crc32: crc, size } = src);
      body = src.raw;
    }
    const name = enc.encode(src.name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, SIG_LOCAL, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, SIG_CENTRAL, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, method, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, body);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, SIG_EOCD, true);
  eocd.setUint16(8, sources.length, true);
  eocd.setUint16(10, sources.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
