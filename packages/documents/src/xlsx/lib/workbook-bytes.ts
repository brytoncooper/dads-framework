/**
 * `writeBuffer()` yields a Node `Buffer` (a `Uint8Array` view) at runtime even
 * though its type reads as an `ArrayBuffer`; copy the viewed bytes so callers
 * get a plain, exactly-sized `ArrayBuffer`.
 */
export function toArrayBuffer(written: ArrayBuffer): ArrayBuffer {
  if (!ArrayBuffer.isView(written)) return written;

  const copy = new ArrayBuffer(written.byteLength);
  new Uint8Array(copy).set(new Uint8Array(written.buffer, written.byteOffset, written.byteLength));
  return copy;
}
