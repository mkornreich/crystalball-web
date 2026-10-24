/**
 * Decoding of Crystal Ball's serialized data-block text.
 *
 * Crystal Ball serializes each block with .NET BinaryFormatter, compresses it
 * with zlib (Xceed ZLibCompressedStream, "fastest" level → 78 01 header) and
 * turns the bytes into text with its own "Base64Coder", which is really a hex
 * coder packing ONE byte per UTF-16 code unit: the high byte of the code unit
 * is the ASCII hex digit of the byte's high nibble, the low byte the hex digit
 * of its low nibble. E.g. byte 0x78 → U+3738 ('7' = 0x37, '8' = 0x38).
 *
 * Blocks written with the (debug) SOAP formatter start with "<SOAP" and are
 * plain XML — those are reported as unsupported.
 */

import { inflate } from './zip';
import { NrbfValue, parseNrbf, simplifyNrbf } from './nrbf';

function hexDigit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

/** Packed-hex text (one byte per UTF-16 code unit) → bytes. */
export function decodePackedHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const cu = text.charCodeAt(i);
    const hi = hexDigit(cu >> 8);
    const lo = hexDigit(cu & 0xff);
    if (hi < 0 || lo < 0) {
      throw new Error(`payload: invalid packed-hex code unit U+${cu.toString(16).padStart(4, '0')} at ${i}`);
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Bytes → packed-hex text (the inverse of decodePackedHex; used by tests and writers). */
export function encodePackedHex(bytes: Uint8Array): string {
  const digits = '0123456789abcdef';
  let s = '';
  for (const b of bytes) s += String.fromCharCode((digits.charCodeAt(b >> 4) << 8) | digits.charCodeAt(b & 0xf));
  return s;
}

/** Packed-hex text → decompressed BinaryFormatter bytes. */
export async function decodeBlockBytes(text: string): Promise<Uint8Array> {
  if (text.startsWith('<SOAP')) throw new Error('payload: SOAP-formatted blocks are not supported');
  return inflate(decodePackedHex(text), 'deflate');
}

/** Packed-hex text → object graph (system collections simplified). */
export async function decodeBlock(text: string, options: { simplify?: boolean } = {}): Promise<NrbfValue> {
  const graph = parseNrbf(await decodeBlockBytes(text));
  return options.simplify === false ? graph : simplifyNrbf(graph);
}
