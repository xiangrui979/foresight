/**
 * BLOB → Float32Array helper (shared by store/retrieve/evolve).
 *
 * node:sqlite returns Uint8Array (own buffer); better-sqlite3 returned Buffer
 * (may be a view with byteOffset). Keep an alignment-safe fallback so any
 * driver's view converts without throwing on odd offsets.
 */
export function blobToF32(buf: Uint8Array): Float32Array {
  if (buf.byteOffset % 4 === 0 && buf.byteLength % 4 === 0) {
    return new Float32Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength / 4)
  }
  const copy = new Uint8Array(buf.byteLength)
  copy.set(buf)
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4)
}
